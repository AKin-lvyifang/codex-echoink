import assert from "node:assert/strict";
import {
  PersonalMemoryCorrectionService,
  parsePersonalMemoryCorrectionPreview
} from "../plugin/personal-memory-correction-service";
import { PersonalMemoryAccessError } from "../harness/memory/personal-memory-repository";
import { PersonalMemoryRecallHarness, serializeRecallBlocks } from "../harness/memory/personal-memory-recall-harness";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";

export async function runPersonalMemoryCorrectionTests(): Promise<void> {
  assertStrictCorrectionPreviewParsing();
  await assertProviderFailuresAndInvalidOutputWriteNothing();
  await assertExternalCancellationPropagatesAndWritesNothing();
  await assertConfirmedCorrectionSupersedesAndReloads();
  await assertRevisionConflictWritesNothing();
}

async function assertExternalCancellationPropagatesAndWritesNothing(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const before = await fixture.repository.inspect();
    let observedSignal: AbortSignal | undefined;
    const service = new PersonalMemoryCorrectionService({
      generateCorrection: async ({ signal }) => {
        observedSignal = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("provider_text_generation_aborted"));
          }, { once: true });
        });
      }
    });
    const controller = new AbortController();
    const pending = service.generatePreview({
      record: {
        kind: "fact",
        title: "旧标题",
        content: "旧内容",
        recallWhen: "需要核对时"
      },
      correction: "停止这次生成",
      signal: controller.signal
    });
    controller.abort();
    await assert.rejects(pending, /provider_text_generation_aborted/u);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(service.active, false);
    assert.deepEqual(await fixture.repository.inspect(), before);
  });
}

function assertStrictCorrectionPreviewParsing(): void {
  assert.deepEqual(parsePersonalMemoryCorrectionPreview(JSON.stringify({
    title: " 修正标题 ",
    content: " 修正内容 ",
    recallWhen: " 需要这个事实时 "
  })), {
    title: "修正标题",
    content: "修正内容",
    recallWhen: "需要这个事实时"
  });
  for (const invalid of [
    "```json\n{}\n```",
    "not json",
    JSON.stringify({ title: "标题", content: "内容" }),
    JSON.stringify({
      title: "标题",
      content: "内容",
      recallWhen: "召回",
      source: "forbidden"
    }),
    JSON.stringify({ title: "", content: "内容", recallWhen: "召回" })
  ]) {
    assert.throws(
      () => parsePersonalMemoryCorrectionPreview(invalid),
      /personal_memory_correction_/u
    );
  }
}

async function assertProviderFailuresAndInvalidOutputWriteNothing(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const before = await fixture.repository.inspect();
    const failures = [
      async () => { throw new Error("provider unavailable"); },
      async () => JSON.stringify({
        title: "模型标题",
        content: "模型内容",
        recallWhen: "模型召回",
        revision: 99
      })
    ];
    for (const generateCorrection of failures) {
      const service = new PersonalMemoryCorrectionService({
        generateCorrection: async () => await generateCorrection()
      });
      await assert.rejects(service.generatePreview({
        record: {
          kind: "fact",
          title: "旧标题",
          content: "旧内容",
          recallWhen: "旧召回"
        },
        correction: "这里不准确"
      }));
      assert.equal(service.active, false);
      assert.deepEqual(await fixture.repository.inspect(), before);
    }
  });
}

async function assertConfirmedCorrectionSupersedesAndReloads(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "旧决定",
      content: "旧决定原文标记：先在蓝鹭进行试点。",
      recallWhen: "讨论当前决定时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ explicitlyAuthorized: true }));
    const corrected = await fixture.repository.supersedeFromUserCorrection({
      targetId: created.record!.id,
      title: "新决定",
      content: "新内容",
      recallWhen: "再次讨论这个决定时",
      reason: "用户明确修正",
      expectedRevision: created.revision
    });
    assert.equal(corrected.record?.kind, "decision");
    assert.equal(corrected.record?.basis, "explicit");
    assert.equal(corrected.record?.contentOrigin, "user_edit");
    assert.equal(corrected.record?.source, "ui://personal-memory-correction");
    assert.equal(corrected.record?.supersedes, created.record!.id);

    const reopened = await fixture.reopen();
    const reloaded = await reopened.readUserControlState();
    const previous = reloaded.records.find((record) =>
      record.id === created.record!.id
    );
    const replacement = reloaded.records.find((record) =>
      record.id === corrected.record!.id
    );
    assert.equal(previous?.status, "superseded");
    assert.equal(replacement?.status, "current");
    assert.equal(replacement?.title, "新决定");
    const runtime = fixture.runtime();
    const prepared = await new PersonalMemoryRecallHarness(reopened).prepareTurnContext({
      memoryMode: "normal", query: "", tokenBudget: 2_000,
      vaultId: runtime.vaultId, conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId, productRunId: runtime.productRunId
    });
    const candidate = prepared.recall!.candidates[0]!;
    assert.equal(candidate.id, corrected.record!.id);
    assert.equal(candidate.status, "current");
    assert.equal(candidate.contentOrigin, "user_edit");
    assert.equal(candidate.supersededRecord?.id, created.record!.id);
    assert.equal(Object.hasOwn(candidate.supersededRecord!, "asOf"), false,
      "旧记录无 asOf 时不能把录入日期猜成成立时间");
    const blocks = serializeRecallBlocks({ ...prepared.recall!, secondaryFacts: [] });
    assert.equal(blocks.combined.includes(created.record!.content), false);
    const historical = await reopened.read(candidate.supersededRecord!.id, runtime, { includeHistorical: true });
    assert.equal(historical.record.content, created.record!.content);
    assert.equal(historical.record.status, "superseded");
  });
}

async function assertRevisionConflictWritesNothing(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "当前观点",
      content: "当前内容",
      recallWhen: "讨论观点时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ explicitlyAuthorized: true }));
    const before = await fixture.repository.inspect();
    await assert.rejects(
      fixture.repository.supersedeFromUserCorrection({
        targetId: created.record!.id,
        title: "陈旧修正",
        content: "不应写入",
        recallWhen: "不应写入",
        reason: "陈旧 revision",
        expectedRevision: created.revision - 1
      }),
      (error) => error instanceof PersonalMemoryAccessError
        && error.code === "revision_conflict"
    );
    assert.deepEqual(await fixture.repository.inspect(), before);
  });
}
