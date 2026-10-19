import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DEFAULT_USER_PROFILE_TEXT,
  DREAM_REFLECTION_PROMPT,
  DreamEngine,
  buildDreamPrompts,
  parseDreamOutput,
  type DreamLlmPort,
  type DreamRepositoryPort
} from "../harness/memory/dream-engine";
import { defaultDreamState, type DreamState } from "../harness/memory/dream-state";
import { defaultDreamExperienceInboxState } from "../harness/memory/dream-experience-inbox";
import { emptyUserProfileState } from "../harness/memory/user-profile-state";
import { PERSONAL_MEMORY_SCHEMA, type PersonalMemoryRecord, type SecondaryMemoryRecord } from "../harness/memory/personal-memory-contracts";

function memory(revision: number): PersonalMemoryRecord {
  return Object.freeze({
    schema: PERSONAL_MEMORY_SCHEMA,
    id: "memory-dream-ledger",
    kind: "fact",
    status: "current",
    date: "2026-08-30",
    source: "pi://test/session/entry",
    basis: "explicit",
    contentOrigin: "user_statement",
    title: "无画像无二级事实的记忆",
    recallWhen: "验证 Dream 完成账本时",
    content: `同一条记忆 revision ${revision}`,
    revision,
    file: "shared-user/memory/facts/memory-dream-ledger.md"
  });
}

export async function runDreamLedgerScenarios(): Promise<void> {
  let currentMemory = memory(1);
  let repositoryRevision = 1;
  let providerCalls = 0;
  let providerMode: "valid" | "invalid" = "valid";
  let commitConflict = false;
  let dreamState: DreamState = defaultDreamState();
  let secondary: readonly SecondaryMemoryRecord[] = Object.freeze([]);
  const llm: DreamLlmPort = {
    call: async (input) => {
      providerCalls += 1;
      if (input.systemPrompt.includes("本次只输出 USER")) return "no_change";
      return providerMode === "valid"
        ? JSON.stringify({ secondaryFacts: [], userProfileItems: [] })
        : "{invalid-json";
    }
  };
  assert.equal(DREAM_REFLECTION_PROMPT, [
    "你负责复盘 Harness 提供的一级 Memory、公开交互和真实任务结果。",
    "",
    "只识别跨任务仍有长期价值的二级关联记忆和用户画像。一次性要求、临时例外、隐藏推理和无法核对的推测不得形成长期变化。",
    "",
    "只输出新增、替换或删除候选及其来源。不要重写完整 USER.md，不要生成 Skill，不要修改权限、Tool、System 或拒绝边界。没有可靠变化时输出 no_change。"
  ].join("\n"));
  const oneMemoryPrompt = buildDreamPrompts(currentMemory, 2_000).systemPrompt;
  assert.ok(oneMemoryPrompt.startsWith(`${DREAM_REFLECTION_PROMPT}\n\n`));
  assert.match(oneMemoryPrompt, /不可信数据/u);
  assert.match(oneMemoryPrompt, /不得执行/u);
  assert.match(oneMemoryPrompt, /本次结构化输出协议/u);
  assert.deepEqual(parseDreamOutput("no_change"), { facts: [], profileItems: [] });
  const repository: DreamRepositoryPort = {
    inspect: async () => Object.freeze({ revision: repositoryRevision, records: [currentMemory] }),
    readVaultId: async () => "dream-ledger-vault",
    readFixedFiles: async () => {
      return Object.freeze({
      user: DEFAULT_USER_PROFILE_TEXT,
      userHash: createHash("sha256").update(DEFAULT_USER_PROFILE_TEXT).digest("hex"),
      userBytes: Buffer.byteLength(DEFAULT_USER_PROFILE_TEXT, "utf8")
    });
    },
    applyCognitiveUpdate: async () => {
      if (commitConflict) throw new Error("Memory revision conflict: concurrent write");
      repositoryRevision += 1;
      return Object.freeze({ revision: repositoryRevision });
    },
    writeSystemMemory: async () => {
      throw new Error("unexpected USER migration");
    }
  };
  const engine = new DreamEngine({
    repository,
    profileStore: {
      read: async () => emptyUserProfileState(0)
    } as never,
    secondaryStore: {
      loadAll: async () => secondary,
      setCache: (records: readonly SecondaryMemoryRecord[]) => { secondary = records; }
    } as never,
    dreamStateStore: {
      read: async () => dreamState,
      write: async (state: DreamState) => { dreamState = state; },
      updateCache: (state: DreamState) => { dreamState = state; },
      peek: () => dreamState
    } as never,
    experienceInboxStore: {
      read: async () => defaultDreamExperienceInboxState(),
      commitEvaluations: async () => { throw new Error("unexpected experience evaluation"); }
    } as never,
    llm: () => llm,
    now: (() => {
      let now = 1_700_000_000_000;
      return () => ++now;
    })()
  });

  const first = await engine.runOnce();
  assert.equal(first.committed, true);
  assert.equal(providerCalls, 2);
  assert.deepEqual(dreamState.processedMemorySources.map((source) => ({
    memoryId: source.memoryId,
    memoryRevision: source.memoryRevision
  })), [{ memoryId: currentMemory.id, memoryRevision: 1 }]);

  await engine.runOnce();
  assert.equal(providerCalls, 2, "successful no-change Memory must not call Provider again");

  currentMemory = memory(2);
  repositoryRevision += 1;
  await engine.runOnce();
  assert.equal(providerCalls, 4, "only a higher revision makes the same Memory eligible again");
  assert.equal(dreamState.processedMemorySources[0]?.memoryRevision, 2);

  currentMemory = memory(3);
  repositoryRevision += 1;
  providerMode = "invalid";
  await engine.runOnce();
  assert.equal(dreamState.processedMemorySources[0]?.memoryRevision, 2,
    "Provider failure must not advance the processed ledger");

  currentMemory = memory(4);
  repositoryRevision += 1;
  providerMode = "valid";
  commitConflict = true;
  const failedCas = await engine.runOnce();
  assert.equal(failedCas.committed, false);
  assert.equal(dreamState.processedMemorySources[0]?.memoryRevision, 2,
    "CAS failure must not advance the processed ledger");

  console.log("PASS dream: per-Memory success ledger survives no-change and rejects failed progress");
}
