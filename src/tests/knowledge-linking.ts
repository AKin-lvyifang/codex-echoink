import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { buildKnowledgeLinkingPatch, buildKnowledgeLinkingTargets, deferKnowledgeLinkingNewLinks, readKnowledgeLinkingDocument, scanKnowledgeLinkingMentions, validateKnowledgeLinkingNewLinks } from "../knowledge-base/knowledge-linking";
import { knowledgeBodyMask, resolveKnowledgeLink, extractKnowledgeLinks } from "../knowledge-base/knowledge-relations";
import type { KnowledgeLinkingDocument, KnowledgeLinkingMention, KnowledgeLinkingTarget } from "../knowledge-base/knowledge-linking-types";

const revision = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const document = (content: string, filePath = "wiki/source.md") => readKnowledgeLinkingDocument(filePath, content, revision(content));
const target = (filePath: string, title: string, aliases: string[] = []): KnowledgeLinkingTarget => ({ path: filePath, title, aliases });
const agent = target("wiki/Agent.md", "Agent", ["智能体"]);

function patch(source: KnowledgeLinkingDocument, mentions: KnowledgeLinkingMention[], targets: KnowledgeLinkingTarget[] = [agent], aliases?: string[], allowAliases = false) {
  return buildKnowledgeLinkingPatch(source, { path: source.path, version: source.version, mentions, ...(aliases ? { aliases } : {}) }, targets, { allowAliases });
}

function aliasesOf(content: string): string[] {
  const yaml = content.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u).slice(1);
  const end = yaml.findIndex((line) => line === "---" || line === "...");
  const value = parseDocument(yaml.slice(0, end).join("\n")).get("aliases");
  return typeof value === "string" ? [value] : (value as { toJSON(): string[] }).toJSON();
}

export async function runKnowledgeLinkingTests(): Promise<void> {
  let groups = 0;
  {
    const source = document('---\r\ntitle: not the title\r\naliases: ["代理", Agent]\r\n---\r\n```md\r\n# Not a title\r\n```\r\n# Actual H1 ##\r\n');
    assert.equal(source.title, "Actual H1");
    assert.deepEqual(source.aliases, ["代理", "Agent"]);
    assert.equal(document("plain body", "知识/文件名.markdown").title, "文件名");
    assert.equal(document("\uFEFF# H1 with BOM\r\nAgent").title, "H1 with BOM");
    assert.deepEqual(document("---\naliases: short\n---\n").aliases, ["short"]);
    groups += 1;
  }
  {
    const source = document([
      "---", "aliases: [Agent]", "note: 智能体", "---", "# Plain", "```ts", "Agent 智能体 <!--", "```",
      "~~~md", "Agent", "~~~", "> ~~~md", "> Agent", "> ~~~", "- ~~~md", "  Agent", "  ~~~", "`Agent` and ``智能体``", "<!-- Agent", "智能体 -->", "    Agent", "\t智能体",
      "[[unknown|Agent]] ![[unknown|智能体]]", "[Agent](https://example.com/a_(b)) ![智能体](image.png)",
      "[Agent][reference] [reference]", "[reference]: https://example.com/智能体", "%% Agent %%", "%% Agent", "智能体 %%", "Agent and 智能体", ""
    ].join("\n"));
    const mentions = scanKnowledgeLinkingMentions(source, [agent]);
    assert.deepEqual(mentions.map((mention) => mention.text), ["Agent", "智能体"]);
    assert.ok(mentions.every((mention) => mention.start >= source.content.indexOf("Agent and")));
    assert.equal(knowledgeBodyMask(source.content).length, source.content.length);
    assert.deepEqual(scanKnowledgeLinkingMentions(document("%% Agent\r\n智能体"), [agent]), []);
    const comment = document("%% Agent %%\r\nAgent");
    assert.equal(patch(comment, [{ start: 3, end: 8, text: "Agent", targetPath: agent.path }]).patch, null);
    const visible = scanKnowledgeLinkingMentions(comment, [agent]);
    assert.equal(visible.length, 1);
    assert.ok(patch(comment, visible).patch!.after.startsWith("%% Agent %%\r\n"));
    groups += 1;
  }
  {
    const source = document("HTTP user agent sends headers. Agent understands tasks. Agentic useragent agents Agent.");
    const mentions = scanKnowledgeLinkingMentions(source, [agent]);
    assert.deepEqual(mentions.map((mention) => mention.text), ["agent", "Agent", "Agent"]);
    assert.equal(patch(source, [mentions[1]]).patch?.after, "HTTP user agent sends headers. [[wiki/Agent.md|Agent]] understands tasks. Agentic useragent agents Agent.");
    assert.equal(patch(source, [mentions[1], mentions[2]]).patch, null);
    groups += 1;
  }
  {
    const source = document("Agent and 智能体 and FileName.");
    const targets = [agent, target("projects/Agent.md", "Different title", ["智能体"]), target("wiki/FileName.md", "A real title")];
    const mentions = scanKnowledgeLinkingMentions(source, targets);
    assert.deepEqual(mentions.filter((mention) => mention.start === 0).map((mention) => mention.targetPath), ["projects/Agent.md", "wiki/Agent.md"]);
    assert.equal(mentions.filter((mention) => mention.text === "智能体").length, 2);
    assert.equal(mentions.filter((mention) => mention.text === "FileName").length, 1);
    assert.equal(patch(source, [mentions[0], mentions[1]], targets).patch, null);
    assert.deepEqual(resolveKnowledgeLink({ link: extractKnowledgeLinks("[[智能体]]")[0], sourcePath: source.path, paths: targets.map((value) => value.path), names: Object.fromEntries(targets.map((value) => [value.path, [value.title, ...value.aliases]])), resolveAlias: (value) => value, hostResolver: () => agent.path }), ["projects/Agent.md", "wiki/Agent.md"]);
    groups += 1;
  }
  {
    const source = document("# Source\r\n[[unknown|old]] [old](old.md) ![[photo.png]]\r\nAgent 智能体\r\n<!-- echoink-source: {\"path\":\"raw/Agent.md\",\"revision\":\"old\"} -->\r\n");
    const chosen = scanKnowledgeLinkingMentions(source, [agent])[0];
    const result = patch(source, [chosen]);
    assert.ok(result.patch);
    assert.deepEqual(Buffer.from(result.patch!.after.replace("[[wiki/Agent.md|Agent]]", "Agent")), Buffer.from(source.content));
    assert.ok(result.patch!.after.includes('<!-- echoink-source: {"path":"raw/Agent.md","revision":"old"} -->'));
    const existing = document("[[Agent]] Agent 智能体.");
    assert.deepEqual(scanKnowledgeLinkingMentions(existing, [agent]), []);
    assert.deepEqual(scanKnowledgeLinkingMentions(document("[already](Agent.md) Agent"), [agent]), []);
    groups += 1;
  }
  {
    const source = document("😀 Agent 原文不改。");
    const mention = scanKnowledgeLinkingMentions(source, [agent])[0];
    assert.equal(mention.start, 3);
    const tamperings: KnowledgeLinkingMention[] = [
      { ...mention, text: "Agents" }, { ...mention, start: -1 }, { ...mention, end: source.content.length + 1 },
      { ...mention, start: mention.start + 1 }, { ...mention, targetPath: "raw/Agent.md" }, { ...mention, targetPath: source.path }
    ];
    for (const tampered of tamperings) assert.equal(patch(source, [tampered]).patch, null);
    assert.equal(buildKnowledgeLinkingPatch(source, { path: source.path, version: revision("other"), mentions: [mention] }, [agent], { allowAliases: false }).patch, null);
    assert.equal(patch({ ...source, content: source.content.replace("原", "新") }, [mention]).patch, null);
    assert.ok(patch(source, [mention]).patch);
    const bomSource = document('\uFEFF---\r\ncustom: "exact" # keep\r\naliases: [old]\r\n---\r\n# BOM note\r\nAgent\r\n');
    const bomPatch = patch(bomSource, scanKnowledgeLinkingMentions(bomSource, [agent])).patch;
    assert.ok(bomPatch);
    assert.deepEqual(Buffer.from(bomPatch!.after.replace("[[wiki/Agent.md|Agent]]", "Agent")), Buffer.from(bomSource.content));
    assert.equal(bomPatch!.after.charCodeAt(0), 0xFEFF);
    groups += 1;
  }
  {
    const attributes = '---\r\nid: 003 # exact\r\ncreated: "2020-01-01"\r\ncustom: {thing: [a, b]}\r\naliases: ["old"] # do not rewrite\r\n---\r\n';
    const source = document(attributes + "Agent\r\n");
    const mention = scanKnowledgeLinkingMentions(source, [agent])[0];
    assert.ok(patch(source, [mention]).patch!.after.startsWith(attributes));
    assert.equal(patch(source, [mention], [agent], ["new"]).patch, null);
    groups += 1;
  }
  {
    const forms = [
      "aliases: old # keep comment\n", "aliases: 'old' # keep comment\n", 'aliases: "old"\n',
      'aliases: [old, "older"] # keep comment\n', "aliases: [old, ]\n", "aliases: []\n",
      "aliases:\n  - old # keep comment\n  - older\n", "aliases:\n- old\n", "aliases: # keep comment\n",
      "aliases: >\n  old alias\n", "aliases: |-\n  old alias\n", "aliases: [old # keep comment\n  ]\n"
    ];
    for (const form of forms) {
      for (const newline of ["\n", "\r\n"]) {
        const prefix = "---\nfirst: 001 # exact\n";
        const suffix = "last: 'exact' # keep\n---\nAgent\n<!-- echoink-source: old -->\n";
        const source = document((prefix + form + suffix).replace(/\n/gu, newline));
        const result = patch(source, [], [agent], ["新增", "new", "new"], true);
        assert.ok(result.patch, `aliases form rejected: ${JSON.stringify(form)} ${JSON.stringify(result.rejected)}`);
        assert.ok(result.patch!.after.startsWith(prefix.replace(/\n/gu, newline)));
        assert.ok(result.patch!.after.endsWith(suffix.replace(/\n/gu, newline)));
        assert.deepEqual(aliasesOf(result.patch!.after), [...source.aliases, "新增", "new"]);
        assert.deepEqual(result.patch!.addedAliases, ["新增", "new"]);
        if (newline === "\r\n") assert.equal(result.patch!.after.replace(/\r\n/gu, "").includes("\n"), false);
      }
    }
    groups += 1;
  }
  {
    for (const content of ["# Body\nAgent", "---\nfirst: 'exact'\n---\nAgent", "\uFEFF# Body\r\nAgent", "---\n# empty mapping\n---\nAgent", "---\nfirst: exact\n...\nAgent"]) {
      const source = document(content);
      const result = patch(source, [], [agent], ["新别名"], true);
      assert.ok(result.patch, result.rejected[0]?.reason);
      assert.ok(result.patch!.after.endsWith(content.replace(/^\uFEFF/u, "").split(/(?:---|\.\.\.)\r?\n/u).at(-1)!));
      assert.deepEqual(aliasesOf(result.patch!.after), ["新别名"]);
    }
    for (const content of ["---\naliases: [a, b\n---\nAgent", "---\naliases: a\naliases: b\n---\nAgent", "---\naliases: {bad: map}\n---\nAgent", "---\naliases: 123\n---\nAgent", "---\naliases: &a [old]\nother: *a\n---\nAgent", "---\n- a\n---\nAgent", "---\naliases: old\nAgent"]) assert.equal(patch(document(content), [], [agent], ["new"], true).patch, null);
    groups += 1;
  }
  {
    const targets = [agent, target("projects/Agent.md", "Other", ["共享"]), target("wiki/Other.md", "Another", ["共享"])];
    const previous = "[[old-missing|old words]] [existing](old.md)\n";
    const candidate = previous + "[[Agent|ambiguous]] [[共享|ambiguous alias]] [[wiki/Agent.md|works]] [[missing|plain words]]\n`[[missing|code]]` <!-- [[missing|comment]] -->\n[external](https://example.com)";
    const result = validateKnowledgeLinkingNewLinks(candidate, "wiki/source.md", targets, previous);
    assert.ok(result.content.startsWith(previous));
    assert.ok(result.content.includes("ambiguous ambiguous alias [[wiki/Agent.md|works]] plain words"));
    assert.ok(result.content.includes("`[[missing|code]]` <!-- [[missing|comment]] -->"));
    assert.equal(result.warnings.length, 3);
    assert.equal(validateKnowledgeLinkingNewLinks("[[Agent|ok]]", "wiki/source.md", [agent]).warnings.length, 0);
    assert.equal(validateKnowledgeLinkingNewLinks("[ok](../wiki/Agent.md)", "projects/source.md", [agent]).warnings.length, 0);
    assert.equal(validateKnowledgeLinkingNewLinks("[[missing|one]] [[missing|one]]", "wiki/source.md", [agent], "[[missing|one]]").content, "[[missing|one]] one");
    assert.equal(validateKnowledgeLinkingNewLinks("[missing words][ref]\n[ref]: wiki/missing.md\n", "wiki/source.md", [agent]).content, "missing words\n[ref]: wiki/missing.md\n");
    const referenceBefore = "[old][ref]\n[ref]: wiki/Agent.md";
    const referenceAfter = "[old][ref]\n[ref]: missing.md";
    const changedReference = validateKnowledgeLinkingNewLinks(referenceAfter, "wiki/source.md", [agent], referenceBefore);
    assert.equal(changedReference.content, "old\n[ref]: missing.md");
    assert.equal(changedReference.warnings.length, 1);
    assert.equal(validateKnowledgeLinkingNewLinks(referenceBefore, "wiki/source.md", [agent], referenceBefore).content, referenceBefore);
    groups += 1;
  }
  {
    const before = '\uFEFF---\r\naliases: [旧别名]\r\ncustom: "keep" # exact\r\n---\r\n# Source\r\n[[wiki/Agent|旧称]] [原写法](Agent.md)\r\n[[raw/source.md|原始材料]]\r\n<!-- echoink-source: {"path":"raw/source.md","revision":"old"} -->\r\n';
    const added = '😀 新提及 [[wiki/Agent.md|智能体]]，又见 [Agent](Agent.md)。\r\n`[[wiki/Agent.md|code]]` <!-- [[wiki/Agent.md|comment]] -->\r\n![[wiki/Agent.md]] [web](https://example.com)\r\n';
    const deferred = deferKnowledgeLinkingNewLinks(before + added, "wiki/source.md", [agent], before);
    assert.equal(deferred, before + added.replace("[[wiki/Agent.md|智能体]]", "智能体").replace("[Agent](Agent.md)", "Agent"),
      "only added knowledge-link wrappers change; old spellings/counts, Raw, YAML, CRLF, BOM, code and comments remain exact");
    assert.equal((deferred.match(/\[\[wiki\/Agent\|旧称\]\]/gu) ?? []).length, 1);
    const repeated = before + '[[wiki/Agent|旧称]]\r\n';
    assert.equal(deferKnowledgeLinkingNewLinks(repeated, "wiki/source.md", [agent], before), before + "旧称\r\n",
      "one old occurrence is protected while an identical newly added occurrence is deferred");
    const oldParagraph = "# Source\n原有段落 [[wiki/Agent.md|智能体]] 保持原位。\n";
    const inserted = "新插段落 [[wiki/Agent.md|智能体]] 在前。\n";
    const insertedFirst = oldParagraph.replace("原有段落", inserted + "原有段落");
    assert.equal(deferKnowledgeLinkingNewLinks(insertedFirst, "wiki/source.md", [agent], oldParagraph), oldParagraph.replace("原有段落", inserted.replace("[[wiki/Agent.md|智能体]]", "智能体") + "原有段落"),
      "text alignment protects the old link's original paragraph even when an identical new link occurs first");
    const ai = target("wiki/AI.md", "AI", ["人工智能"]);
    const late = "# Agent\nAgent 是人工智能系统。AI 中文是[[wiki/AI.md|人工智能]]。\n";
    const plain = deferKnowledgeLinkingNewLinks(late, "wiki/Agent.md", [ai]);
    const source = document(plain, "wiki/Agent.md");
    const candidates = scanKnowledgeLinkingMentions(source, [ai]);
    assert.equal(candidates.length, 3, "a late authored link no longer masks earlier mentions of its target");
    assert.match(patch(source, [candidates[0]], [ai]).patch!.after, /Agent 是\[\[wiki\/AI.md\|人工智能\]\]系统/u);
    groups += 1;
  }
  {
    const documents = Array.from({ length: 75 }, (_, index) => document(`# Concept ${index}\nAgent`, `wiki/page-${index}.md`));
    assert.equal(buildKnowledgeLinkingTargets(documents).length, 75);
    assert.equal(documents.flatMap((source) => scanKnowledgeLinkingMentions(source, [agent])).length, 75);
    assert.equal(buildKnowledgeLinkingTargets([document("Agent", "../outside.md"), document("Agent", "wiki/Bad|target.md")]).length, 0);
    groups += 1;
  }
  console.log(`Knowledge linking core: ${groups} test groups passed.`);
}
