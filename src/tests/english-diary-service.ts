import { paidTestAccess } from "./membership-access";
import * as assert from "node:assert/strict";
import { EnglishDiaryService } from "../english-diary/service";
import { fingerprint, normalizePrivacy, splitDiaryBlocks } from "../english-diary/model";
import { buildDiaryPrompt as productionBuildPrompt, parseDiaryGeneration as productionParse } from "../english-diary/prompt";
import { getBuiltinSkillDefinition, renderBuiltinSkill } from "../harness/resources/builtin-skills";
import type { DiaryGenerator, DiaryPrivacy, DiaryRecord, DiaryRepository, DiaryResult, DiarySource } from "../english-diary/types";

const SOURCE = "I finally 鼓起勇气 to ask.\nPRIVATE-MEDICAL-DETAIL\nI didn't explain why.";
const sourceOf = (content: string): DiarySource => ({ path: "journal/2026-10-05.md", title: "A day", date: "2026-10-05", content });
function privacyOf(content: string, excluded = "PRIVATE-MEDICAL-DETAIL"): DiaryPrivacy {
  const blocks = splitDiaryBlocks(content);
  return { sourceFingerprint: fingerprint(content), rules: blocks.map((block) => ({ blockId: block.id,
    mode: block.text.includes(excluded) || block.protected ? "exclude" : "translate" })) };
}
function responseFor(userPrompt: string, withExpression = true): string {
  const input = JSON.parse(userPrompt) as { blocks: Array<{ id: string; mode: string; text: string }> };
  const translated = input.blocks.filter((block) => block.mode === "translate");
  const first = translated.find((block) => block.text.includes("鼓起勇气"));
  return JSON.stringify({ blocks: translated.map((block) => ({ id: block.id,
    english: block.text.replace(/鼓起勇气/gu, "worked up the courage"),
    alignments: block.id === first?.id ? [{ id: "courage", kind: "translation", source: [{ quote: "鼓起勇气", occurrence: 0 }],
      target: [{ quote: "worked up the courage", occurrence: 0 }], reason: "之前犹豫，最后开口，强调克服心理障碍。" }] : [] })),
  expressions: withExpression && first ? [{ blockId: first.id, term: "work up the courage", type: "phrase", meaning: "鼓起勇气",
    category: "情绪感受", scene: "原本犹豫，最后提出请求。", example: "I worked up the courage to bring it up.",
    reason: "强调克服心理障碍后开口。", usage: "适合谈论原本不敢做的事。", sourceExcerpt: "鼓起勇气",
    targetExcerpt: "worked up the courage", alignmentId: "courage" }] : [] });
}

function fixture(initial = SOURCE) {
  let source = sourceOf(initial);
  let record: DiaryRecord = { schema: 1, id: "journal-1", sourcePath: source.path, englishPath: "EchoInk/英文日记/2026-10-05.md",
    result: null, savedFileFingerprint: null, privacy: null, pending: null, missingEnglish: false, englishModified: false,
    observedFileFingerprint: null };
  let calls = 0, skillCalls = 0, publishes = 0, restores = 0;
  const requests: Array<{ systemPrompt: string; userPrompt: string; signal: AbortSignal }> = [];
  let generate: DiaryGenerator["generate"] = async (input) => responseFor(input.userPrompt);
  const repository: DiaryRepository = {
    listGenerationActivity: async () => [],
    async get() { return record; },
    async publish(_record, result, options) {
      if (options.signal?.aborted || !await options.sourceUnchanged()) throw new Error("SOURCE_CHANGED");
      publishes++;
      record = { ...record, result, pending: null, missingEnglish: false, englishModified: false,
        savedFileFingerprint: fingerprint(result.english), observedFileFingerprint: fingerprint(result.english) };
      return record;
    },
    async savePrivacy(_record, privacy) { record = { ...record, privacy }; },
    async restore() { restores++; record = { ...record, missingEnglish: false }; return record; },
    async listExpressions() { return []; },
    async updateExpression() { throw new Error("not used"); },
    async removeOccurrence() {},
    async markExpression() { return record; },
    async renameSource() {}
  };
  const generator: DiaryGenerator = {
    async generate(input) { calls++; requests.push(input); return await generate(input); },
    async skill() { skillCalls++; return "Natural English diary Skill"; },
    providerLabel() { return "Fixture Provider"; }
  };
  const service = new EnglishDiaryService(repository, generator, async () => source, paidTestAccess);
  return { service, repository, requests, record: () => record,
    counts: () => ({ calls, skillCalls, publishes, restores }),
    setSource: (content: string) => { source = sourceOf(content); },
    setRecord: (patch: Partial<DiaryRecord>) => { record = { ...record, ...patch }; },
    setGenerator: (next: DiaryGenerator["generate"]) => { generate = next; } };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !check(); index++) await Promise.resolve();
  assert.equal(check(), true, "fixture operation started");
}

export async function runEnglishDiaryServiceTests(): Promise<void> {
  const skill = getBuiltinSkillDefinition("english-diary");
  assert.ok(skill, "the production controller can load the registered builtin Skill");
  assert.match(renderBuiltinSkill(skill), /id: english-diary[\s\S]*permissions: \[\]/u);
  assert.match(skill.body, /普通聊天[\s\S]*不自动触发/u);
  // Offsets preserve CRLF, frontmatter and fenced code without normalizing the
  // source fingerprint or leaking protected text into the generated prompt.
  const markdown = "---\r\nsecret: red\r\n---\r\n\r\nHello 鼓起勇气\r\n```js\r\nconst secret = 7;\r\n```\r\n[link](https://example.com)\r\n";
  const blocks = splitDiaryBlocks(markdown);
  assert.equal(blocks.length, 4);
  assert.equal(blocks.filter((block) => block.protected).length, 3);
  for (const block of blocks) assert.equal(markdown.slice(block.start, block.end), block.text);
  const defaults = normalizePrivacy(blocks, fingerprint(markdown), null);
  const prompt = buildDiaryPrompt(blocks, defaults, "skill");
  assert.doesNotMatch(prompt.userPrompt, /secret|example\.com/u);
  assert.notEqual(fingerprint("not now"), fingerprint("not  now"));
  const parsed = parseDiaryGeneration(responseFor(prompt.userPrompt, false), markdown, blocks, defaults);
  assert.equal(parsed.english, markdown.replace("鼓起勇气", "worked up the courage"));
  assert.equal(parsed.expressions.length, 0, "no filler expressions required");
  const preserveSource = "I said hello.\n保持这一句\nPRIVATE-MEDICAL-DETAIL";
  const preserveBlocks = splitDiaryBlocks(preserveSource), preservePrivacy = privacyOf(preserveSource);
  preservePrivacy.rules[1].mode = "preserve";
  const preservePrompt = buildDiaryPrompt(preserveBlocks, preservePrivacy, "skill");
  assert.match(preservePrompt.userPrompt, /保持这一句/u, "preserve may be sent as context");
  assert.doesNotMatch(preservePrompt.userPrompt, /PRIVATE-MEDICAL-DETAIL/u);
  const preserveOutput = responseFor(preservePrompt.userPrompt, false);
  assert.equal(parseDiaryGeneration(preserveOutput, preserveSource, preserveBlocks, preservePrivacy).english, preserveSource);
  const forgedExpression = JSON.parse(responseFor(buildDiaryPrompt(splitDiaryBlocks(SOURCE), privacyOf(SOURCE), "").userPrompt));
  forgedExpression.expressions[0].sourceExcerpt = "PRIVATE-MEDICAL-DETAIL";
  assert.throws(() => parseDiaryGeneration(JSON.stringify(forgedExpression), SOURCE, splitDiaryBlocks(SOURCE), privacyOf(SOURCE)),
    (error: any) => error.code === "english_diary_invalid_result", "expressions cannot claim a private block as their source");

  const originalPrivacy = privacyOf(SOURCE);
  const edited = SOURCE.replace("finally", "eventually");
  const migrated = normalizePrivacy(splitDiaryBlocks(edited), fingerprint(edited), originalPrivacy);
  assert.equal(migrated.rules.filter((rule) => rule.mode === "exclude").length, 1);
  const movedSecret = SOURCE.replace("PRIVATE-MEDICAL-DETAIL", "PRIVATE-MEDICAL-DETAIL edited");
  assert.throws(() => normalizePrivacy(splitDiaryBlocks(movedSecret), fingerprint(movedSecret), originalPrivacy),
    (error: any) => error.code === "english_diary_privacy_review_required");
  const duplicated = `${SOURCE}\nPRIVATE-MEDICAL-DETAIL\nI mentioned PRIVATE-MEDICAL-DETAIL again.`;
  const duplicatedPrivacy = normalizePrivacy(splitDiaryBlocks(duplicated), fingerprint(duplicated), originalPrivacy);
  assert.equal(duplicatedPrivacy.rules.filter((rule) => rule.mode === "exclude").length, 3);

  // Repeated quotes have separate occurrence identities. Without an occurrence
  // or unique context, no exact source line is invented.
  const repeated = "鼓起勇气，然后鼓起勇气";
  const repeatedBlocks = splitDiaryBlocks(repeated), repeatedPrivacy = privacyOf(repeated);
  const repeatedOutput = JSON.parse(responseFor(buildDiaryPrompt(repeatedBlocks, repeatedPrivacy, "").userPrompt, false));
  delete repeatedOutput.blocks[0].alignments[0].source[0].occurrence;
  delete repeatedOutput.blocks[0].alignments[0].target[0].occurrence;
  assert.equal(parseDiaryGeneration(JSON.stringify(repeatedOutput), repeated, repeatedBlocks, repeatedPrivacy).alignments.length, 0);
  repeatedOutput.blocks[0].alignments[0].source[0].occurrence = 1;
  repeatedOutput.blocks[0].alignments[0].target[0].occurrence = 1;
  const repeatedParsed = parseDiaryGeneration(JSON.stringify(repeatedOutput), repeated, repeatedBlocks, repeatedPrivacy);
  assert.equal(repeatedParsed.alignments[0].source[0].start, repeated.lastIndexOf("鼓起勇气"));
  repeatedOutput.blocks[0].alignments[0].source[0].occurrence = 5;
  assert.equal(parseDiaryGeneration(JSON.stringify(repeatedOutput), repeated, repeatedBlocks, repeatedPrivacy).alignments.length, 0);

  const f = fixture();
  const generated = await f.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  assert.equal(f.counts().calls, 1);
  assert.equal(generated.result?.english, SOURCE.replace("鼓起勇气", "worked up the courage"));
  assert.equal(generated.result?.expressions.length, 1);
  assert.doesNotMatch(f.requests[0].userPrompt, /PRIVATE-MEDICAL-DETAIL/u);
  assert.ok(generated.result?.english.endsWith("I didn't explain why."), "natural original English stays unchanged");
  const alignment = generated.result!.alignments[0];
  assert.equal(SOURCE.slice(alignment.source[0].start, alignment.source[0].end), alignment.source[0].text);
  assert.equal(generated.result!.english.slice(alignment.target[0].start, alignment.target[0].end), alignment.target[0].text);
  await f.service.generate(sourceOf(SOURCE).path);
  assert.deepEqual(f.counts(), { calls: 1, skillCalls: 1, publishes: 1, restores: 0 });
  // A new service instance proves the gate lives in persisted result identity,
  // rather than only a disabled button or a per-view in-memory flag.
  const reopened = new EnglishDiaryService(f.repository, { generate: async () => { throw new Error("must not generate"); },
    skill: async () => { throw new Error("must not load provider"); }, providerLabel: () => "" }, async () => sourceOf(SOURCE), paidTestAccess);
  await reopened.generate(sourceOf(SOURCE).path);
  f.setRecord({ missingEnglish: true });
  await f.service.generate(sourceOf(SOURCE).path);
  assert.equal(f.counts().restores, 1);
  assert.equal(f.counts().calls, 1);
  f.setSource(edited);
  f.setSource(SOURCE);
  await f.service.generate(sourceOf(SOURCE).path);
  assert.equal(f.counts().calls, 1, "A to B to A reuses A");

  // Published text is retained through bad output and manually edited English
  // is never overwritten on a stale confirmation.
  f.setSource(edited);
  f.setGenerator(async () => "{ broken");
  await assert.rejects(f.service.generate(sourceOf(SOURCE).path), (error: any) => error.code === "english_diary_invalid_result");
  assert.equal(f.record().result?.operationId, generated.result?.operationId);
  f.setRecord({ englishModified: true, observedFileFingerprint: "manual-new" });
  await assert.rejects(f.service.generate(sourceOf(SOURCE).path), (error: any) => error.code === "english_diary_overwrite_required");
  await assert.rejects(f.service.generate(sourceOf(SOURCE).path, { overwriteModified: true, expectedEnglishFingerprint: "manual-old" }),
    (error: any) => error.code === "english_diary_overwrite_required");
  assert.equal(f.counts().calls, 2, "blocked overwrites do not consume a new model call");
  f.setGenerator(async (input) => responseFor(input.userPrompt));
  await f.service.generate(sourceOf(SOURCE).path, { overwriteModified: true, expectedEnglishFingerprint: "manual-new" });
  assert.equal(f.counts().calls, 3);

  const concurrent = fixture();
  let finish!: (value: string) => void;
  concurrent.setGenerator(() => new Promise((resolve) => { finish = resolve; }));
  const request = concurrent.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  assert.equal(concurrent.service.generate(sourceOf(SOURCE).path), request, "same operation shares one promise");
  await until(() => concurrent.counts().calls === 1);
  concurrent.service.cancel(sourceOf(SOURCE).path);
  finish(responseFor(concurrent.requests[0].userPrompt));
  await assert.rejects(request, (error: any) => error.code === "english_diary_cancelled");
  assert.equal(concurrent.counts().publishes, 0, "late cancelled response cannot publish");

  const changed = fixture();
  changed.setGenerator(() => new Promise((resolve) => { finish = resolve; }));
  const staleRequest = changed.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  await until(() => changed.counts().calls === 1);
  changed.setSource(edited);
  finish(responseFor(changed.requests[0].userPrompt));
  await assert.rejects(staleRequest, (error: any) => error.code === "english_diary_source_changed");
  assert.equal(changed.counts().publishes, 0);

  const recovered = fixture();
  const pending = { ...generated.result!, operationId: "recover-me" } satisfies DiaryResult;
  recovered.setRecord({ pending, privacy: originalPrivacy });
  await recovered.service.generate(sourceOf(SOURCE).path);
  assert.equal(recovered.counts().calls, 0, "recover an already generated package without model billing");
  assert.equal(recovered.record().result?.operationId, "recover-me");

  const allExcluded = fixture("KEEP-THIS-LOCAL");
  await allExcluded.service.generate(sourceOf(SOURCE).path, { privacy: privacyOf("KEEP-THIS-LOCAL", "KEEP-THIS-LOCAL") });
  assert.equal(allExcluded.counts().calls, 0);
  assert.equal(allExcluded.record().result?.english, "KEEP-THIS-LOCAL");
  const longPrivateContent = `Hello.\n${"PRIVATE".repeat(11_000)}`;
  const longPrivate = fixture(longPrivateContent);
  await longPrivate.service.generate(sourceOf(SOURCE).path, { privacy: privacyOf(longPrivateContent, "PRIVATE") });
  assert.equal(longPrivate.counts().calls, 1, "excluding long private content genuinely narrows the model request");
  assert.doesNotMatch(longPrivate.requests[0].userPrompt, /PRIVATE/u);

  const revoke = fixture();
  revoke.setGenerator(() => new Promise((resolve) => { finish = resolve; }));
  const pendingGeneration = revoke.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  await until(() => revoke.counts().calls === 1);
  const stricter = privacyOf(SOURCE);
  stricter.rules[0].mode = "exclude";
  await revoke.service.savePrivacy(sourceOf(SOURCE).path, stricter);
  assert.equal(revoke.requests[0].signal.aborted, true, "tightening privacy cancels pending generation/approval");
  finish(responseFor(revoke.requests[0].userPrompt));
  await assert.rejects(pendingGeneration, (error: any) => error.code === "english_diary_cancelled");
  assert.equal(revoke.counts().publishes, 0);

  const disable = fixture();
  disable.setGenerator(() => new Promise((resolve) => { finish = resolve; }));
  const pendingDisable = disable.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  await until(() => disable.counts().calls === 1);
  disable.service.cancelAll();
  assert.equal(disable.requests[0].signal.aborted, true, "disabling the module cancels active generation");
  finish(responseFor(disable.requests[0].userPrompt));
  await assert.rejects(pendingDisable, (error: any) => error.code === "english_diary_cancelled");
  assert.equal(disable.counts().publishes, 0);

  const preparing = fixture();
  let releaseRecord!: (value: DiaryRecord) => void;
  let reading = false;
  preparing.repository.get = () => { reading = true; return new Promise((resolve) => { releaseRecord = resolve; }); };
  const preparingGeneration = preparing.service.generate(sourceOf(SOURCE).path, { privacy: originalPrivacy });
  await until(() => reading);
  preparing.service.cancel(sourceOf(SOURCE).path);
  releaseRecord(preparing.record());
  await assert.rejects(preparingGeneration, (error: any) => error.code === "english_diary_cancelled");
  assert.equal(preparing.counts().calls, 0, "cancellation during repository loading must never reach the Provider");
}

const buildDiaryPrompt = (...args: Parameters<typeof productionBuildPrompt>) => productionBuildPrompt(args[0], args[1], args[2], true);
const parseDiaryGeneration = (...args: Parameters<typeof productionParse>) => productionParse(args[0], args[1], args[2], args[3], true);
