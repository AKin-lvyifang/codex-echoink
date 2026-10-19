import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DREAM_EXPERIENCE_MAX_BYTES, DREAM_EXPERIENCE_MAX_ITEMS, DreamExperienceInboxStore,
  appendDreamPublicExperience, defaultDreamExperienceInboxState, dreamExperienceInboxJson,
  markDreamExperiencesEvaluated, normalizeDreamPublicExperience } from "../harness/memory/dream-experience-inbox";
import { buildDreamProfilePrompts, buildDreamProfileSources, parseDreamProfileOutput } from "../harness/memory/dream-engine";
import { buildDreamPublicExperienceFromRun } from "../harness/pi-native/pi-native-conversation-runtime";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem } from "../harness/memory/cognitive-system";

export async function runDreamGrowthScenarios(): Promise<void> {
  await scenarioInboxIsBoundedAndDeduplicated();
  scenarioRuntimeCaptureKeepsOnlyPublicMinimalData();
  scenarioUserEvidenceIsStillRequired();
  await scenarioProductRunMemoryAndExperienceAreNotDoubleCounted();
  await scenarioSameRunProviderAndParseFailuresKeepExperiencePending();
  await scenarioSameRunExperienceStillRunsProvider();
  await scenarioInvalidDreamLeavesExperiencePending();
  await scenarioDreamCasFailureLeavesExperiencePending();
  await scenarioUserProfileDreamAndSuppressionPreserveOldSelf();
  console.log("PASS Dream user profile, source evidence, experience, suppression and retired Self boundaries");
}

function scenarioUserEvidenceIsStillRequired(): void {
  const one = normalizeDreamPublicExperience(experienceInput(1, "我长期喜欢简短回答"));
  const two = normalizeDreamPublicExperience(experienceInput(2, "我长期喜欢简短回答"));
  const sources = buildDreamProfileSources([], [one, two], 2_000);
  const output = (basis: string, ids = [0]) => JSON.stringify({ userProfileItems: [{
    section: "preference", profileKey: "preference.detail", text: "喜欢简短回答", basis,
    sources: ids.map((i) => ({ sourceId: sources[i]!.sourceId, evidenceQuote: "我长期喜欢简短回答" }))
  }] });
  assert.equal(parseDreamProfileOutput(output("explicit"), sources)?.userProfileItems.length, 1);
  assert.equal(parseDreamProfileOutput(output("inferred"), sources)?.userProfileItems.length, 0);
  assert.equal(parseDreamProfileOutput(output("inferred", [0, 1]), sources)?.userProfileItems.length, 1);
  const sameRun = buildDreamProfileSources([], [one, { ...two, productRunId: one.productRunId }], 2_000);
  assert.equal(parseDreamProfileOutput(output("inferred", [0, 1]), sameRun)?.userProfileItems.length, 0);
  const assistantOnly = buildDreamProfileSources([], [{ ...one, userText: "你好", assistantText: "我长期喜欢简短回答" }], 2_000);
  assert.equal(parseDreamProfileOutput(output("explicit"), assistantOnly)?.userProfileItems.length, 0);
  assert.equal(parseDreamProfileOutput(JSON.stringify({ agentSelfOperations: [] }), sources), null);
  const prompt = buildDreamProfilePrompts(sources);
  assert.doesNotMatch(prompt.systemPrompt + prompt.userPrompt, /agentSelfOperations|currentLearnedHabits|current-self|habit_add|AGENT\.md/u);
}

async function scenarioUserProfileDreamAndSuppressionPreserveOldSelf(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const oldAgent = "# OLD_SELF_NEVER_TOUCH\nI used to grow.\n";
    const oldMeta = "invalid-old-metadata";
    await mkdir(path.dirname(fixture.repository.layout.agent), { recursive: true });
    await writeFile(fixture.repository.layout.agent, oldAgent);
    await writeFile(fixture.repository.layout.agentSelfMetadata, oldMeta);
    const memory = await fixture.repository.write({ operation: "create", kind: "fact", title: "交流偏好",
      content: "我长期喜欢简短回答", recallWhen: "交流时", basis: "explicit", contentOrigin: "user_statement" }, fixture.runtime());
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experienceInput(91, "我长期喜欢简短回答"), fixture.now());
    let profileCalls = 0;
    const system = await CognitiveSystem.create({ repository: fixture.repository,
      llm: () => ({ call: async (input) => {
        assert.doesNotMatch(input.systemPrompt + input.userPrompt, /OLD_SELF_NEVER_TOUCH|agentSelfOperations|currentLearnedHabits|habit_add|AGENT\.md/u);
        if (!input.systemPrompt.includes("本次只输出 USER")) return JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
        profileCalls++;
        const { sources } = JSON.parse(input.userPrompt);
        return JSON.stringify({ userProfileItems: [{ section: "preference", profileKey: "preference.detail",
          text: "喜欢简短回答", basis: "explicit", sources: sources.map((source: { sourceId: string }) => ({ sourceId: source.sourceId, evidenceQuote: "我长期喜欢简短回答" })) }] });
      } }), getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false, registerInterval: () => undefined, now: fixture.now });
    try {
      const result = await system.engine.runOnce();
      assert.equal(result.committed, true);
      assert.equal(Object.hasOwn(result, "agentUpdated"), false);
      assert.equal(profileCalls, 1);
      assert.notEqual((await inbox.read()).entries[0]?.evaluatedAt, null);
      const profile = await fixture.repository.readUserProfileControlSnapshot();
      assert.ok(profile.items.some((item) => item.profileKey === "preference.detail"));
      await fixture.repository.deleteUserProfileFromUserControl({ profileKey: "preference.detail", expectedRevision: profile.revision });
      await inbox.append(experienceInput(92, "我长期喜欢简短回答"), fixture.now());
      await system.engine.runOnce();
      const suppressed = await fixture.repository.readUserProfileControlSnapshot();
      assert.equal(suppressed.items.some((item) => item.profileKey === "preference.detail"), false);
      assert.ok((await system.profileStore.read())?.deletionBarriers?.length);
      await fixture.repository.forgetFromUserControl(memory.record!.id, "忘记来源", suppressed.revision);
      assert.equal(await readFile(fixture.repository.layout.agent, "utf8"), oldAgent);
      assert.equal(await readFile(fixture.repository.layout.agentSelfMetadata, "utf8"), oldMeta);
    } finally { await system.dispose(); }
  });
}

async function scenarioInboxIsBoundedAndDeduplicated(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-dream-inbox-"));
  try {
    const store = new DreamExperienceInboxStore(root);
    const first = experienceInput(0, "以后默认先给结论");
    await store.append(first, 1);
    await store.append(first, 2);
    const deduped = await store.read();
    assert.equal(deduped.entries.length, 1);
    assert.equal(deduped.duplicateCount, 1);

    let state = defaultDreamExperienceInboxState();
    state = appendDreamPublicExperience(state, first, 1);
    state = markDreamExperiencesEvaluated(
      state,
      new Set([state.entries[0]!.fingerprint]),
      2
    );
    for (let index = 1; index <= DREAM_EXPERIENCE_MAX_ITEMS + 2; index += 1) {
      state = appendDreamPublicExperience(state, experienceInput(index, `公开输入 ${index}`), index + 2);
    }
    assert.equal(state.entries.length, DREAM_EXPERIENCE_MAX_ITEMS);
    assert.equal(state.droppedEvaluatedCount, 1, "oldest evaluated entries leave first");
    assert.equal(state.droppedUnevaluatedCount, 2, "overflow of pending entries stays diagnostic");

    const beforeOversizeDrops = state.droppedUnevaluatedCount;
    state = appendDreamPublicExperience(
      state,
      experienceInput(999, "大".repeat(DREAM_EXPERIENCE_MAX_BYTES)),
      999
    );
    assert.ok(Buffer.byteLength(dreamExperienceInboxJson(state), "utf8") <= DREAM_EXPERIENCE_MAX_BYTES);
    assert.ok(state.droppedUnevaluatedCount > beforeOversizeDrops);
    assert.equal(state.entries.some((entry) => entry.productRunId === "run-999"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


function scenarioRuntimeCaptureKeepsOnlyPublicMinimalData(): void {
  const entries = [
    {
      type: "message",
      id: "user-entry",
      message: {
        role: "user",
        content: [
          { type: "text", text: "公开问题" },
          { type: "image", data: "ATTACHMENT_BODY_SECRET" }
        ],
        timestamp: 1
      }
    },
    {
      type: "message",
      id: "assistant-entry",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "HIDDEN_REASONING_SECRET" },
          { type: "text", text: "公开答复" },
          { type: "toolCall", id: "call-1", name: "vault_write", arguments: { secret: "RAW_TOOL_SECRET" } }
        ],
        stopReason: "stop",
        timestamp: 2
      }
    },
    {
      type: "message",
      id: "tool-entry",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "vault_write",
        content: [{ type: "text", text: "RAW_TOOL_RESULT_SECRET" }],
        details: { secret: "RAW_TOOL_DETAILS_SECRET" },
        isError: false,
        timestamp: 3
      }
    }
  ] as never;
  const captured = buildDreamPublicExperienceFromRun({
    conversationId: "conversation-public",
    productRunId: "run-public",
    userEntryId: "user-entry",
    assistantEntryId: "assistant-entry",
    terminalState: "completed",
    occurredAt: 4,
    entries
  });
  assert.ok(captured);
  assert.equal(captured.userText, "公开问题");
  assert.equal(captured.assistantText, "公开答复");
  assert.deepEqual(captured.taskResult.successfulToolNames, ["vault_write"]);
  const json = JSON.stringify(captured);
  for (const secret of [
    "ATTACHMENT_BODY_SECRET",
    "HIDDEN_REASONING_SECRET",
    "RAW_TOOL_SECRET",
    "RAW_TOOL_RESULT_SECRET",
    "RAW_TOOL_DETAILS_SECRET"
  ]) assert.doesNotMatch(json, new RegExp(secret, "u"));
}


async function scenarioProductRunMemoryAndExperienceAreNotDoubleCounted(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "同一次任务的长期观察",
      content: "复杂任务中先核对证据",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-covered-same-round" }));
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    const appended = await inbox.append(Object.freeze({
      ...experienceInput(42, "本次任务中先核对证据"),
      productRunId: "run-covered-same-round"
    }), fixture.now());
    const duplicateSourceId = `experience:${appended.entries[0]!.fingerprint}`;
    const sources = buildDreamProfileSources(
      (await fixture.repository.inspect()).records.filter((record) => record.status === "current"),
      [appended.entries[0]!],
      2_000
    );
    assert.equal(sources.length, 2);
    assert.deepEqual(
      [...new Set(sources.map((source) => source.contextId))],
      ["task:run-covered-same-round"],
      "Memory and Experience from one ProductRun remain visible but count as one independent context"
    );
    let profilePromptSeen = false;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({
        call: async (request) => {
          if (!request.systemPrompt.includes("本次只输出 USER")) {
            return JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
          }
          profilePromptSeen = true;
          assert.match(request.userPrompt, new RegExp(duplicateSourceId, "u"));
          assert.match(request.userPrompt, /run-covered-same-round/u);
          return "no_change";
        }
      }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, true);
    assert.equal(profilePromptSeen, true);
    assert.notEqual((await inbox.read()).entries[0]?.evaluatedAt, null,
      "same-ProductRun Experience is evaluated only after its own public evidence is analyzed");
  });
}


async function scenarioSameRunProviderAndParseFailuresKeepExperiencePending(): Promise<void> {
  for (const failure of ["provider", "parse"] as const) {
    await withPersonalMemoryFixture(async (fixture) => {
      await fixture.repository.write({
        operation: "create",
        kind: "view",
        title: `同组 ${failure} 失败记忆`,
        content: "以后默认在复杂任务中先核对证据。",
        recallWhen: "处理复杂任务时",
        basis: "explicit",
        contentOrigin: "user_statement"
      }, fixture.runtime({ productRunId: `run-same-group-${failure}` }));
      const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
      await inbox.append(Object.freeze({
        ...experienceInput(failure === "provider" ? 70 : 71, "同轮还有未写入 Memory 的公开习惯证据"),
        productRunId: `run-same-group-${failure}`
      }), fixture.now());
      const system = await CognitiveSystem.create({
        repository: fixture.repository,
        llm: () => ({
          call: async (request) => {
            if (!request.systemPrompt.includes("本次只输出 USER")) {
              return JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
            }
            if (failure === "provider") throw new Error("same_group_provider_failed");
            return "{invalid-profile-json";
          }
        }),
        getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
        isForegroundBusy: () => false,
        registerInterval: () => undefined,
        now: fixture.now
      });
      const result = await system.engine.runOnce();
      assert.equal(result.committed, false);
      assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null,
        `same-ProductRun ${failure} failure must keep Experience pending`);
    });
  }
}


async function scenarioSameRunExperienceStillRunsProvider(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "先完成一级记忆",
      content: "复杂任务中保持结构",
      recallWhen: "处理复杂任务时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime({ productRunId: "run-covered-later" }));
    let providerLookups = 0;
    let providerCalls = 0;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => {
        providerLookups += 1;
        return {
          call: async (request) => {
            providerCalls += 1;
            return request.systemPrompt.includes("本次只输出 USER")
              ? "no_change"
              : JSON.stringify({ secondaryFacts: [], userProfileItems: [] });
          }
        };
      },
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    assert.equal((await system.engine.runOnce()).committed, true);
    assert.equal(providerLookups, 1);
    assert.equal(providerCalls, 2);

    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(Object.freeze({
      ...experienceInput(43, "同一任务的公开经历"),
      productRunId: "run-covered-later"
    }), fixture.now());
    const experienceOnly = await system.engine.runOnce();
    assert.equal(experienceOnly.committed, true);
    assert.equal(experienceOnly.providerUnavailable, false);
    assert.equal(experienceOnly.error, null);
    assert.equal(providerLookups, 2,
      "same-ProductRun public evidence must still enter the independent USER analysis");
    assert.equal(providerCalls, 3);
    assert.notEqual((await inbox.read()).entries[0]?.evaluatedAt, null);
  });
}


async function scenarioInvalidDreamLeavesExperiencePending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experienceInput(41, "以后默认保持清晰结构"), fixture.now());
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({ call: async () => "{invalid-json" }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, false);
    assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null);
  });
}


async function scenarioDreamCasFailureLeavesExperiencePending(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experienceInput(44, "以后默认保持清晰结构"), fixture.now());
    let injectedConcurrentWrite = false;
    const system = await CognitiveSystem.create({
      repository: fixture.repository,
      llm: () => ({
        call: async () => {
          if (!injectedConcurrentWrite) {
            injectedConcurrentWrite = true;
            await fixture.repository.write({
              operation: "create",
              kind: "fact",
              title: "并发写入",
              content: "在 Dream Provider 调用后推进 Memory revision",
              recallWhen: "验证 Dream CAS 时",
              basis: "explicit",
              contentOrigin: "user_statement"
            }, fixture.runtime({ productRunId: "run-concurrent-write" }));
          }
          return "no_change";
        }
      }),
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false,
      registerInterval: () => undefined,
      now: fixture.now
    });
    const result = await system.engine.runOnce();
    assert.equal(result.committed, false);
    assert.match(result.error ?? "", /revision conflict/iu);
    assert.equal((await inbox.read()).entries[0]?.evaluatedAt, null,
      "Repository CAS failure must leave the Experience retryable");
  });
}


function experienceInput(index: number, userText: string) {
  return Object.freeze({
    conversationId: `conversation-${index}`,
    productRunId: `run-${index}`,
    userEntryId: `user-${index}`,
    assistantEntryId: `assistant-${index}`,
    occurredAt: index + 1,
    userText,
    assistantText: `公开答复 ${index}`,
    taskResult: Object.freeze({
      terminalState: "completed" as const,
      successfulToolNames: Object.freeze([`tool_${index}`]),
      failedToolNames: Object.freeze([])
    })
  });
}
