import assert from "node:assert/strict";
import { buildInlineCandidates, proposalTarget, sectionAt, sectionForRange, type InlineCandidate } from "../inline-agent/candidates";
import { anchorAt, cleanDocument, markerFor } from "../inline-agent/document";
import {
  freezeInlineModelRequest, inlineProposalContextContent, INLINE_PROPOSAL_SYSTEM_PROMPT,
  InlineModelProtocolError, parseInlineModelOutput, type InlineModelOutput, type InlineModelRequest
} from "../inline-agent/protocol";
import type { InlineRequest } from "../inline-agent/types";

let checks = 0;
function check(name: string, run: () => void): void { run(); checks++; console.log(`PASS ${name}`); }
const ownCommand = `@小墨 整理这一节 ${markerFor("range-request")}`;
const otherCommand = `@小墨 另一个请求 ${markerFor("other-request")}`;
type Proposal = Extract<InlineModelOutput, { kind: "proposal" }>;

function fixture(document: string, controls = [ownCommand]) {
  const from = document.indexOf(ownCommand);
  assert.ok(from >= 0);
  const instruction = { ...anchorAt(document, { from, to: from + ownCommand.length }), trigger: "@", marker: markerFor("range-request") };
  const request: InlineRequest = { id: "range-request", vaultId: "test", path: "范围测试.md", taskId: "range-task", agentId: "agent", agentName: "小墨",
    instruction, target: { ...anchorAt(document, { from: instruction.to, to: instruction.to }), kind: "insert" }, status: "thinking", observedDocument: document,
    versions: [], currentVersionId: "", followups: [], createdAt: 1, updatedAt: 1 };
  const context = cleanDocument(document, controls.map(control => { const start = document.indexOf(control); assert.ok(start >= 0); return { from: start, to: start + control.length }; }));
  const candidates = buildInlineCandidates(document, context, request);
  const model = freezeInlineModelRequest({ requestId: request.id, context: context.text,
    candidates: candidates.map(({ id, kind, text, label, boundaryGroup }) => ({ id, kind, text, label, ...(boundaryGroup ? { boundaryGroup } : {}) })) });
  return { document, request, context, candidates, model };
}
function candidate(f: ReturnType<typeof fixture>, text: string, occurrence = 0): InlineCandidate {
  const found = f.candidates.filter(item => item.kind === "replace" && item.text === text)[occurrence];
  assert.ok(found, `missing candidate ${JSON.stringify(text)} in ${JSON.stringify(f.candidates)}`);
  return found;
}
function rangeOutput(start: InlineCandidate, end: InlineCandidate, text = "整理后的正文"): Proposal {
  return { kind: "proposal", startCandidateId: start.id, endCandidateId: end.id, text };
}
function parsed(model: InlineModelRequest, value: unknown): Proposal {
  const output = parseInlineModelOutput(JSON.stringify(value), model);
  assert.equal(output.kind, "proposal");
  return output as Proposal;
}

check("legacy exact sentence, insertion and requests without boundary metadata remain supported", () => {
  const f = fixture(`前句。要改的句子。后句。\n\n${ownCommand}\n`), body = candidate(f, "前句。要改的句子。后句。");
  const single = { kind: "proposal", candidateId: body.id, original: "要改的句子。", text: "新句子。" } as const;
  const target = proposalTarget(f.document, f.candidates, parsed(f.model, single));
  assert.equal(target.text, single.original); assert.equal(target.from, f.document.indexOf(single.original));
  assert.equal(target.kind, "replace");
  for (const id of ["insert-here", "insert-end"]) {
    const output = parsed(f.model, { kind: "proposal", candidateId: id, original: "", text: "补写" });
    const insertion = proposalTarget(f.document, f.candidates, output);
    assert.equal(insertion.kind, "insert"); assert.equal(insertion.from, insertion.to); assert.equal(insertion.text, "");
    assert.equal(insertion.from, id === "insert-here" ? f.request.instruction.to : f.document.length);
  }
  const legacy = freezeInlineModelRequest({ requestId: "legacy", context: "旧正文", candidates: [{ id: "old", kind: "replace", text: "旧正文", label: "正文" }] });
  assert.deepEqual(parsed(legacy, { kind: "proposal", candidateId: "old", original: "正文", text: "新正文" }),
    { kind: "proposal", candidateId: "old", original: "正文", text: "新正文" });
  assert.equal("boundaryGroup" in legacy.candidates[0], false);
});

check("a multi-paragraph target is an exact source slice preserving empty lines, indentation, trailing spaces and outside newlines", () => {
  for (const ending of ["", "\n", "\n\n"]) {
    const body = "  第一段尾有空格。  \n\n \t\n\t第二段。\n同段第二行。  \n\n最后一段。  ";
    const f = fixture(`${ownCommand}\n\n${body}${ending}`), first = candidate(f, "  第一段尾有空格。  "), last = candidate(f, "最后一段。  ");
    const output = parsed(f.model, rangeOutput(first, last));
    assert.equal("original" in output, false);
    const target = proposalTarget(f.document, f.candidates, output);
    assert.equal(target.text, body); assert.equal(target.from, first.from); assert.equal(target.to, last.to);
    assert.equal(target.text, f.document.slice(first.from, last.to));
    assert.equal(f.document.slice(target.to), ending);
    assert.ok(target.text.includes("\n\n \t\n\t"));
    assert.notEqual(target.text, f.candidates.filter(item => item.kind === "replace").map(item => item.text).join("\n\n"));
  }
});

check("repeated paragraphs resolve by this turn's IDs while a repeated single substring still fails", () => {
  const f = fixture(`${ownCommand}\n\n重复段。\n\n重复段。\n\n重复重复`), first = candidate(f, "重复段。", 0), second = candidate(f, "重复段。", 1);
  assert.notEqual(first.id, second.id);
  const target = proposalTarget(f.document, f.candidates, parsed(f.model, rangeOutput(first, second)));
  assert.equal(target.text, "重复段。\n\n重复段。");
  const duplicate = candidate(f, "重复重复");
  assert.throws(() => proposalTarget(f.document, f.candidates, parsed(f.model, { kind: "proposal", candidateId: duplicate.id, original: "重复", text: "改" })), /无法唯一定位/u);
  const secondOnly = proposalTarget(f.document, f.candidates, parsed(f.model, { kind: "proposal", candidateId: second.id, original: second.text, text: "改" }));
  assert.equal(secondOnly.from, second.from);
});

check("range protocol rejects unknown, reversed, equal, insertion, mixed and extra-field endpoints", () => {
  const f = fixture(`${ownCommand}\n\n第一段。\n\n第二段。`), first = candidate(f, "第一段。"), last = candidate(f, "第二段。");
  const valid = rangeOutput(first, last);
  for (const value of [
    { ...valid, startCandidateId: "unknown" }, { ...valid, endCandidateId: "unknown" },
    { ...valid, startCandidateId: last.id, endCandidateId: first.id }, { ...valid, endCandidateId: first.id },
    { ...valid, startCandidateId: "insert-here" }, { ...valid, endCandidateId: "insert-end" },
    { ...valid, original: "第一段。\n\n第二段。" }, { ...valid, candidateId: first.id }, { ...valid, offset: 0 },
    { ...valid, text: null }, { kind: "proposal", startCandidateId: first.id, text: "缺少末候选" },
    { kind: "proposal", endCandidateId: last.id, text: "缺少首候选" }
  ]) assert.throws(() => parsed(f.model, value), InlineModelProtocolError);
  assert.throws(() => parsed(f.model, rangeOutput(first, first)), /单候选格式/u);
  const mixed = { ...f.model, candidates: [first, { id: "middle-insert", kind: "insert" as const, text: "", label: "插入" }, last] };
  assert.throws(() => parsed(mixed, valid), InlineModelProtocolError);
  const noBoundary = { ...f.model, candidates: [first, last].map(({ boundaryGroup: _group, ...rest }) => rest) };
  assert.throws(() => parsed(noBoundary, valid), InlineModelProtocolError);
  const clarification = { kind: "clarification", question: "要改哪两段？", options: [{ id: "adjacent", label: "连续两段" }, { id: "separate", label: "分开修改" }] };
  assert.deepEqual(parseInlineModelOutput(JSON.stringify(clarification), f.model), clarification);
});

check("truncated, repaired, fenced or concatenated JSON never becomes a proposal", () => {
  const f = fixture(`${ownCommand}\n\n甲。\n\n乙。`), output = rangeOutput(candidate(f, "甲。"), candidate(f, "乙。")), raw = JSON.stringify(output);
  for (const invalid of [raw.slice(0, -1), `\`\`\`json\n${raw}\n\`\`\``, `${raw}\n${raw}`, raw + "说明", raw.slice(0, -1) + ",}"]) {
    assert.throws(() => parseInlineModelOutput(invalid, f.model), InlineModelProtocolError);
  }
  for (const reason of ["length", "aborted", "error", "toolUse"]) {
    assert.throws(() => parseInlineModelOutput(raw, f.model, reason), (error: unknown) => error instanceof InlineModelProtocolError && error.code === "incomplete_output");
  }
});

check("ATX headings are separate candidates without blank lines and heading offsets belong to their own hierarchical section", () => {
  const f = fixture(`# 项目\n开场。\n## 范围\n第一段。\n\n第二段。\n### 细节 ###  \n细节正文。\n\n${ownCommand}`);
  assert.deepEqual(f.candidates.filter(item => item.kind === "replace").map(item => item.text),
    ["# 项目", "开场。", "## 范围", "第一段。", "第二段。", "### 细节 ###  ", "细节正文。"]);
  assert.equal(candidate(f, "## 范围").label, "项目 › 范围");
  assert.equal(candidate(f, "第一段。").label, "项目 › 范围");
  assert.equal(candidate(f, "### 细节 ###  ").label, "项目 › 范围 › 细节");
  const start = candidate(f, "## 范围").from;
  assert.equal(sectionAt(f.document, start), "项目 › 范围");
  assert.equal(sectionForRange(f.document, { from: start, to: start }), "项目 › 范围");
  assert.equal(sectionForRange(f.document, { from: candidate(f, "第一段。").from, to: candidate(f, "第二段。").to }), "项目 › 范围");
  const target = proposalTarget(f.document, f.candidates, parsed(f.model, rangeOutput(candidate(f, "第一段。"), candidate(f, "第二段。"))));
  assert.equal(target.text, "第一段。\n\n第二段。"); assert.ok(!target.text.includes("## 范围"));
});

check("parent paths and repeated sibling identities distinguish same-named sections", () => {
  const f = fixture(`# 甲\n## 同名\n甲段。\n# 乙\n## 同名\n乙一。\n## 同名\n乙二。\n\n${ownCommand}`);
  assert.equal(candidate(f, "甲段。").label, "甲 › 同名");
  assert.equal(candidate(f, "乙一。").label, "乙 › 同名（第1处）");
  assert.match(candidate(f, "乙二。").label, /^乙 › 同名（第2处）/u);
  assert.equal(sectionForRange(f.document, { from: candidate(f, "甲段。").from, to: candidate(f, "乙一。").to }), "甲 › 同名 › 乙 › 同名（第1处）");
  assert.equal(sectionForRange(f.document, { from: candidate(f, "乙一。").from, to: candidate(f, "乙二。").to }), "乙 › 同名（第1处） › 乙 › 同名（第2处）");
  assert.equal(sectionForRange(f.document, { from: candidate(f, "甲段。").from, to: candidate(f, "# 乙").from }), "甲 › 同名");
  const repeated = fixture(`# 同名\n甲。\n# 同名\n乙。\n\n${ownCommand}`);
  assert.equal(sectionForRange(repeated.document, { from: candidate(repeated, "甲。").from, to: candidate(repeated, "乙。").to }), "同名（第1处） › 同名（第2处）");
  const mixedLevels = fixture(`# 父标题\n### 同名\n甲。\n## 同名\n乙。\n\n${ownCommand}`);
  assert.equal(candidate(mixedLevels, "甲。").label, "父标题 › 同名（第1处）");
  assert.match(candidate(mixedLevels, "乙。").label, /^父标题 › 同名（第2处）/u);
});

check("backtick and tilde code fences do not create sections, including shorter inner fences", () => {
  const f = fixture(`# 真标题\n\n\`\`\`\`md\n# 伪标题\n\`\`\`\n## 仍是代码\n\`\`\`\`\n\n~~~md\n## 另一个伪标题\n~~~\n\n    # 缩进代码\n\n   ## 真小节\n正文。\n\n${ownCommand}`);
  assert.equal(sectionAt(f.document, f.document.indexOf("# 伪标题")), "真标题");
  assert.equal(sectionAt(f.document, f.document.indexOf("## 仍是代码")), "真标题");
  assert.equal(sectionAt(f.document, f.document.indexOf("## 另一个伪标题")), "真标题");
  assert.equal(sectionAt(f.document, f.document.indexOf("    # 缩进代码")), "真标题");
  assert.equal(candidate(f, "   ## 真小节").label, "真标题 › 真小节");
  assert.ok(f.candidates.some(item => item.text.includes("# 伪标题") && item.text.startsWith("````md\n")));
  assert.ok(!f.candidates.some(item => item.text === "# 伪标题"));
});

check("only complete leading YAML frontmatter hides heading-shaped comments", () => {
  for (const closing of ["---", "..."]) {
    const f = fixture(`---\n# YAML 注释\naliases: []\n${closing}\n\n正文前言。\n\n# 真标题\n正文。\n\n${ownCommand}`);
    assert.equal(sectionAt(f.document, f.document.indexOf("# YAML 注释")), "正文");
    assert.equal(candidate(f, "正文前言。").label, "正文");
    assert.ok(!f.candidates.some(item => item.text === "# YAML 注释"));
    assert.equal(candidate(f, "# 真标题").label, "真标题");
  }
  const incomplete = fixture(`---\n# 仍是正文标题\n正文。\n\n${ownCommand}`);
  assert.equal(candidate(incomplete, "# 仍是正文标题").label, "仍是正文标题");
});

check("model material retains immutable boundary groups and omits all control text and editor offsets", () => {
  const f = fixture(`甲。\n\n${ownCommand}\n\n乙。\n\n${otherCommand}\n\n丙。`, [ownCommand, otherCommand]);
  const groups = [candidate(f, "甲。"), candidate(f, "乙。"), candidate(f, "丙。")].map(item => item.boundaryGroup);
  assert.equal(new Set(groups).size, 3);
  const material = JSON.parse(inlineProposalContextContent(f.model)) as { context: string; candidates: Array<Record<string, unknown>> };
  assert.ok(!material.context.includes("@小墨")); assert.ok(!material.context.includes("%%echoink:"));
  for (const item of material.candidates) {
    assert.equal("from" in item || "to" in item, false);
    if (item.kind === "replace") assert.ok(groups.includes(item.boundaryGroup as string));
  }
  const mutable = structuredClone(f.model), frozen = freezeInlineModelRequest(mutable);
  (mutable.candidates as Array<{ boundaryGroup?: string }>)[0].boundaryGroup = "changed";
  assert.equal(frozen.candidates[0].boundaryGroup, groups[0]); assert.ok(Object.isFrozen(frozen.candidates[0]));
  assert.throws(() => freezeInlineModelRequest({ ...f.model, candidates: [{ ...f.model.candidates[0], boundaryGroup: " " }] }), InlineModelProtocolError);
});

check("ranges across own or another control are refused before target resolution with move-instruction guidance", () => {
  const f = fixture(`甲。\n\n${ownCommand}\n\n乙。\n\n${otherCommand}\n\n丙。`, [ownCommand, otherCommand]);
  for (const [start, end] of [["甲。", "乙。"], ["乙。", "丙。"], ["甲。", "丙。"]]) {
    const output = rangeOutput(candidate(f, start), candidate(f, end));
    assert.throws(() => parsed(f.model, output), /把 @ 指令移到要改的范围外再试/u);
    assert.throws(() => proposalTarget(f.document, f.candidates, output), /把 @ 指令移到要改的范围外再试/u);
  }
  const inline = fixture(`前文${ownCommand}后文\n\n末段。`);
  assert.throws(() => parsed(inline.model, rangeOutput(candidate(inline, "前文"), candidate(inline, "末段。"))), /把 @ 指令移到要改的范围外再试/u);
});

check("source offsets independently reject uncovered control holes, changed text and out-of-order candidates", () => {
  const f = fixture(`甲。\n\n${ownCommand}\n\n乙。`), first = candidate(f, "甲。"), last = candidate(f, "乙。"), output = rangeOutput(first, last);
  const forged = f.candidates.map(item => ({ ...item, boundaryGroup: "one-group" }));
  assert.throws(() => proposalTarget(f.document, forged, output), /把 @ 指令移到要改的范围外再试/u);
  const valid = fixture(`${ownCommand}\n\n甲。\n\n乙。`), a = candidate(valid, "甲。"), b = candidate(valid, "乙。");
  assert.throws(() => proposalTarget(valid.document.replace("甲。", "改。"), valid.candidates, rangeOutput(a, b)), /正文已变化/u);
  const reversed = [{ ...b, id: a.id }, { ...a, id: b.id }];
  assert.throws(() => proposalTarget(valid.document, reversed, rangeOutput(a, b)), /顺序无效/u);
});

check("model instructions require clarification for disjoint or ambiguous targets and preserve section titles by default", () => {
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /目标不连续.*必须追问/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /同名小节指代不清/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /默认保留标题/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /首尾不主动纳入标题候选/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /中间的标题必须包含在连续范围内，并原样保留/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /boundaryGroup/u);
  assert.match(INLINE_PROPOSAL_SYSTEM_PROMPT, /不做自动补全、结构修复或写入/u);
});

console.log(`PASS inline-agent ranges: ${checks} checks`);
