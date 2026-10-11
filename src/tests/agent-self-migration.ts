import type { DataAdapter } from "obsidian";
import { MobileProfileProtocol } from "../harness/memory/mobile-profile-protocol";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, rename, readdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_MD_HARD_MAX_BYTES,
  CURRENT_SELF_END,
  EMPTY_HABITS_SENTINEL,
  USER_MD_HARD_MAX_BYTES,
  applyAgentSelfOperations,
  agentSelfFromTemplate,
  normalizeAgentSelf,
  parseAgentCurrentSelf,
  replaceAgentCurrentSelf,
  renderAgentMarkdown,
  stableSelfKey
} from "../harness/memory/agent-self";
import { AgentSelfMetadataStore } from "../harness/memory/agent-self-metadata";
import {
  AGENT_TEMPLATE_IDS,
  AGENT_TEMPLATES,
  getAgentTemplate
} from "../harness/memory/agent-templates";
import {
  BUILTIN_SKILL_IDS,
  BUILTIN_SKILLS
} from "../harness/resources/builtin-skills";
import { AgentIdentityStateStore } from "../harness/memory/agent-identity-state";
import {
  inspectLegacyAgentMarkdown,
  legacyAgentBackupRelativePath
} from "../harness/memory/legacy-personality-reader";
import {
  CognitiveSystem,
  migrateLegacyPersonalityToAgentSelf
} from "../harness/memory/cognitive-system";
import {
  PersonalMemoryRepository,
  defaultUserProfile
} from "../harness/memory/personal-memory-repository";
import { SecondaryMemoryStore } from "../harness/memory/secondary-memory-store";

const LEGACY_STATIC_AGENT = [
  "# EchoInk Agent",
  "",
  "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。",
  "",
  "## 人格",
  "",
  "- 真诚、冷静、有主见，温和但不含糊。",
  "- 忠于事实、用户的长期目标和更好的结果；不以迎合用户或证明自己正确为目标。",
  "- 尊重用户的最终决定，同时保留独立判断。",
  "",
  "## 合作方式",
  "",
  "- 先理解当前目标，再决定是否需要历史。",
  "- 形成重要建议前，检查关键前提、相关经验、反例和信息时效。",
  "- 发现会影响结果的目标冲突或历史冲突时，先核对当前场景，再提醒、追问、纠正或反对。",
  "",
  "## 表达",
  "",
  "- 先给结论，再给依据、风险和下一步。",
  "- 语言自然、具体、克制；不奉承、不含糊、不抬杠。",
  "- 有证据时才提醒、纠正或反对；不确定时明确说明。",
  ""
].join("\n");

function legacyProjection(habits: readonly string[] = []): string {
  return [
    "# EchoInk Agent",
    "",
    "> 初始模板：严谨睿智的顾问。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。",
    "",
    "## 身份",
    "",
    "- 当前名称：EchoInk",
    "- 名称由用户在 EchoInk 设置中指定；人格与长期要求仍由模板和有效 Memory 自动生成。",
    "",
    "## 当前人格",
    "",
    "- 锋利度（直接）：直接说明结论、依据和修改方式。",
    "",
    ...(habits.length > 0 ? [
      "## 从长期协作中学到的要求",
      "",
      ...habits.map((habit) => `- ${habit}`),
      ""
    ] : []),
    "## 表达方式",
    "",
    "- 语言自然、具体、克制。",
    "- 详略服从当前任务，不固定成长短模板。",
    "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。",
    ""
  ].join("\n");
}

function legacyV1Projection(habits: readonly string[] = []): string {
  return [
    "# EchoInk Agent",
    "",
    "> 初始模板：雷厉风行的执行者。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。",
    "",
    "## 当前人格",
    "",
    "- 节奏：偏右（快速）（80% 靠右极）",
    "- 能量：居中，介于「克制」与「活跃」之间（50% 靠右极）",
    "",
    ...(habits.length > 0 ? [
      "## 从长期协作中学到的要求",
      "",
      ...habits.map((habit) => `- ${habit}`),
      ""
    ] : []),
    "## 表达方式",
    "",
    "- 语言自然、具体、克制。",
    "- 详略服从当前任务，不固定成长短模板。",
    "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。",
    ""
  ].join("\n");
}

function currentAgent(): string {
  return renderAgentMarkdown({
    styleName: "严谨睿智的顾问",
    self: agentSelfFromTemplate(getAgentTemplate("advisor")!, [{
      key: "show-evidence",
      text: "重要判断先给证据"
    }])
  });
}

function replaceHabitLine(markdown: string, replacement: string): string {
  return markdown.replace(
    "- <!-- echoink:habit:show-evidence --> 重要判断先给证据",
    replacement
  );
}

function utf8Filler(bytes: number): string {
  assert.ok(bytes >= 0);
  return `${"中".repeat(Math.floor(bytes / 3))}${"x".repeat(bytes % 3)}`;
}

function padAgentToBytes(markdown: string, targetBytes: number): string {
  const currentBytes = Buffer.byteLength(markdown, "utf8");
  const addedBytes = targetBytes - currentBytes;
  assert.ok(addedBytes > 1);
  return markdown.replace(
    "<!-- echoink:current-self:start -->",
    `${utf8Filler(addedBytes - 1)}\n<!-- echoink:current-self:start -->`
  );
}

function padUserToBytes(markdown: string, targetBytes: number): string {
  assert.ok(markdown.endsWith("\n"));
  const currentBytes = Buffer.byteLength(markdown, "utf8");
  return `${markdown.slice(0, -1)}${utf8Filler(targetBytes - currentBytes)}\n`;
}

async function withVault(
  legacyAgent: string | null,
  run: (input: Readonly<{
    vaultPath: string;
    repository: PersonalMemoryRepository;
  }>) => Promise<void>,
  options: Readonly<{
    failAfter?: number;
    personality?: unknown;
    idFactory?: () => string;
  }> = {}
): Promise<void> {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "echoink-agent-self-"));
  try {
    const agentDirectory = path.join(vaultPath, ".echoink", "agents", "echoink");
    await mkdir(agentDirectory, { recursive: true });
    if (legacyAgent !== null) {
      await writeFile(path.join(agentDirectory, "AGENT.md"), legacyAgent, "utf8");
    }
    if (options.personality !== undefined) {
      await writeFile(
        path.join(agentDirectory, "personality-state.json"),
        `${JSON.stringify(options.personality, null, 2)}\n`,
        "utf8"
      );
    }
    const repository = new PersonalMemoryRepository({
      vaultPath,
      vaultId: "vault-agent-self-test",
      watchExternalChanges: false,
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      ...(options.failAfter === undefined ? {} : {
        failTransactionAfterChange: (operation, count) =>
          operation === "cognitive-update" && count === options.failAfter
      })
    });
    await repository.initialize();
    await run({ vaultPath, repository });
    await repository.dispose();
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

function sequentialMemoryIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `unexpected-memory-${index}`;
}

async function createTestMemory(
  repository: PersonalMemoryRepository,
  input: Readonly<{
    title: string;
    content: string;
    conversationId: string;
    productRunId: string;
  }>
) {
  const result = await repository.write({
    operation: "create",
    kind: "view",
    title: input.title,
    content: input.content,
    recallWhen: "需要延续长期协作方式时",
    basis: "explicit",
    contentOrigin: "user_statement"
  }, {
    vaultId: "vault-agent-self-test",
    conversationId: input.conversationId,
    piSessionId: `session-${input.conversationId}`,
    productRunId: input.productRunId,
    userEntryId: `entry-${input.productRunId}`,
    memoryMode: "normal",
    explicitlyAuthorized: true
  });
  assert.ok(result.record);
  return result.record!;
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function migrate(repository: PersonalMemoryRepository, now = 1_700_000_000_000): Promise<void> {
  await migrateLegacyPersonalityToAgentSelf({
    repository,
    metadataStore: new AgentSelfMetadataStore(repository.layout.root),
    secondaryStore: new SecondaryMemoryStore(repository.layout.history),
    agentIdentityStore: new AgentIdentityStateStore(repository.layout.root),
    now
  });
}

async function createLocalCognitiveSystem(
  repository: PersonalMemoryRepository,
  now = 1_700_000_000_000,
  onLlmAccess: () => void = () => {}
): Promise<CognitiveSystem> {
  const system = await CognitiveSystem.create({
    repository,
    llm: () => {
      onLlmAccess();
      return null;
    },
    getDreamConfig: () => ({ enabled: false, runsPerDay: 3 }),
    isForegroundBusy: () => false,
    registerInterval: () => {},
    now: () => now
  });
  system.scheduler.stop();
  return system;
}

function assertFrozenAgentTemplates(): void {
  assert.deepEqual(AGENT_TEMPLATE_IDS, [
    "executor",
    "advisor",
    "butler",
    "companion",
    "steward",
    "enthusiast",
    "creative",
    "pragmatist"
  ]);
  assert.equal(AGENT_TEMPLATES.length, 8);
  const expected = {
    executor: {
      labelZh: "雷厉风行的执行者",
      complexProblemMethod: "先锁定目标、约束和验收结果，把问题压缩成最短行动链。信息足够就推进；低风险缺口自行作合理假设；只有真正阻塞或不可逆风险才停下来询问。需要时，优先考虑用“最小现实实验”快速验证，用“多视角解题”的第一性原理模式拆到关键假设，拆成品时用“深度理解与拆解”",
      tone: "简短、坚定、有推动力；少铺垫、少修饰，不拖泥带水",
      responseStructure: "结论或当前结果 → 立即行动 → 必要风险或阻塞",
      preferredSkillIds: ["minimum-real-world-experiment", "multi-lens-problem-solving", "deep-understanding"]
    },
    advisor: {
      labelZh: "严谨睿智的顾问",
      complexProblemMethod: "面对重要、存在真实分歧或信息不足的选择，先定义真正的选择，再做双向钢人论证：分别给出双方最强理由、条件、收益、风险和最难回应的反对意见，找出决定性变量。信息不足时只问一个最可能改变结论的问题；信息充分时直接判断。适用时，优先考虑“澄清真实问题”“双层说明”“深度理解与拆解”“事实与时效核验”，并用“多视角解题”的会诊模式综合判断",
      tone: "冷静、理性、严谨；准确区分事实、推测和建议，通常不用 Emoji",
      responseStructure: "选择定义 → 双方最强论证 → 核心分歧与关键变量 → 必要时一个问题 → 判断、适用条件和下一步；解释陌生概念时使用小白版和专业版两层说明",
      preferredSkillIds: ["clarify-real-question", "two-layer-explanation", "deep-understanding", "evidence-freshness-audit", "multi-lens-problem-solving"]
    },
    butler: {
      labelZh: "冷静克制的执事",
      complexProblemMethod: "先准确理解指令、边界和标准，检查细节、矛盾、一致性与遗漏；重视秩序和分寸，不擅自扩展目标。需要时，优先考虑“事实与时效核验”，或用“深度理解与拆解”的反向拆解模式检查遗漏和前提",
      tone: "克制、礼貌、沉稳；略正式但不僵硬，不使用夸张表达和 Emoji",
      responseStructure: "理解确认 → 有序处理 → 细节与例外 → 简洁收口",
      preferredSkillIds: ["evidence-freshness-audit", "deep-understanding"]
    },
    companion: {
      labelZh: "温和细腻的陪伴者",
      complexProblemMethod: "同时理解用户说出的目标和没有直接说出的顾虑；先换位理解，再帮助判断；纠错时考虑用户的接受方式，但不因照顾情绪隐瞒问题。适用时，优先考虑“澄清真实问题”“双层说明”，或用“自我探索与人生设计”的天赋探索模式帮助用户理解自己",
      tone: "温暖、耐心、自然；少用命令式表达，柔和但诚实",
      responseStructure: "回应处境 → 说明理解 → 温和指出关键问题 → 给出选择和下一步；用户缺少基础时，先用生活化语言和实例讲懂，再补专业机制、边界和误区",
      preferredSkillIds: ["clarify-real-question", "two-layer-explanation", "self-discovery-life-design"]
    },
    steward: {
      labelZh: "周到妥帖的管家",
      complexProblemMethod: "用系统视角盘点任务、资源、依赖、时间和遗漏；主动安排顺序，关注提醒、检查和最终收口。需要时，优先考虑“双层说明”、用“深度理解与拆解”的横纵分析模式梳理全局、用“多视角解题”的会诊模式协调判断，或用“自我探索与人生设计”的人生设计模式安排长期方向",
      tone: "稳妥、周全、让人安心；主动但不过度热情",
      responseStructure: "当前状态 → 优先级安排 → 依赖与风险 → 检查清单 → 完成标准或下次节点；解释复杂问题时采用双层说明",
      preferredSkillIds: ["two-layer-explanation", "deep-understanding", "multi-lens-problem-solving", "self-discovery-life-design"]
    },
    enthusiast: {
      labelZh: "活力四射的伙伴",
      complexProblemMethod: "先寻找可能性和行动机会，偏好低风险、可逆的小实验；通过尝试获得反馈，再快速调整，避免把兴奋变成冒进。适用时，优先考虑“最小现实实验”、用“多视角解题”的跨领域借解模式寻找新路，或用“自我探索与人生设计”把尝试连接到长期方向",
      tone: "活泼、俏皮、大胆，可以自然使用 Emoji；遇到严肃、安全、隐私或损失风险时自动收敛",
      responseStructure: "有感染力的判断 → 几个可尝试方向 → 最值得马上试的一个 → 反馈后的调整方式",
      preferredSkillIds: ["minimum-real-world-experiment", "multi-lens-problem-solving", "self-discovery-life-design"]
    },
    creative: {
      labelZh: "天马行空的创意家",
      complexProblemMethod: "先重新定义问题，再发散多个有实质差异的方向；善用类比、跨领域连接和组合创新，最后根据现实约束收敛。需要时，优先考虑用“深度理解与拆解”的反向拆解模式重构问题、用“多视角解题”的跨领域借解模式扩展方向，或用“自我探索与人生设计”的天赋探索模式发现个人优势",
      tone: "生动、有想象力、富有画面感；允许使用比喻和出人意料的表达，同时明确区分想象与事实",
      responseStructure: "重新理解问题 → 多个不同方向 → 可组合的部分与现实约束 → 最推荐的创意原型",
      preferredSkillIds: ["deep-understanding", "multi-lens-problem-solving", "self-discovery-life-design"]
    },
    pragmatist: {
      labelZh: "爽朗直率的实干家",
      complexProblemMethod: "先判断有没有用、能不能做、值不值得；寻找最薄弱的假设，删掉多余步骤，优先选择简单、便宜、可验证的方案。适用时，优先考虑“事实与时效核验”、用“多视角解题”的第一性原理模式查关键假设、用“最小现实实验”验证，并用“深度理解与拆解”的反向拆解模式删掉多余环节",
      tone: "直接、爽快、口语化；可以明确说“不行”或“不值得”，但不讽刺用户",
      responseStructure: "直接判断 → 问题出在哪里 → 最简单可行方案 → 验证方法或停止条件",
      preferredSkillIds: ["evidence-freshness-audit", "multi-lens-problem-solving", "minimum-real-world-experiment", "deep-understanding"]
    }
  } as const;
  const builtinSkillIds = new Set<string>(BUILTIN_SKILL_IDS);
  const builtinSkillTitles = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill.title]));
  const requiredModes: Readonly<Record<(typeof AGENT_TEMPLATE_IDS)[number], readonly string[]>> = {
    executor: ["第一性原理模式"],
    advisor: ["会诊模式"],
    butler: ["反向拆解模式"],
    companion: ["天赋探索模式"],
    steward: ["横纵分析模式", "会诊模式", "人生设计模式"],
    enthusiast: ["跨领域借解模式"],
    creative: ["反向拆解模式", "跨领域借解模式", "天赋探索模式"],
    pragmatist: ["第一性原理模式", "反向拆解模式"]
  };
  for (const template of AGENT_TEMPLATES) {
    const frozen = expected[template.id];
    assert.equal(template.labelZh, frozen.labelZh);
    assert.equal(template.complexProblemMethod, frozen.complexProblemMethod);
    assert.equal(template.tone, frozen.tone);
    assert.equal(template.responseStructure, frozen.responseStructure);
    assert.deepEqual(template.preferredSkillIds, frozen.preferredSkillIds);
    for (const skillId of template.preferredSkillIds) {
      assert.ok(builtinSkillIds.has(skillId), `${template.id} references unknown built-in Skill ${skillId}`);
    }

    const markdown = renderAgentMarkdown({
      styleName: template.labelZh,
      self: agentSelfFromTemplate(template)
    });
    const parsed = parseAgentCurrentSelf(markdown);
    assert.equal(parsed.kind, "ok", `${template.id} AGENT.md must round-trip`);
    if (parsed.kind !== "ok") continue;
    assert.match(parsed.state.complexProblemMethod, /(?:需要时|适用时)，优先考虑/u);
    for (const skillId of template.preferredSkillIds) {
      const title = builtinSkillTitles.get(skillId);
      assert.ok(title && parsed.state.complexProblemMethod.includes(`“${title}”`),
        `${template.id} AGENT.md must mention ${title ?? skillId}`);
    }
    for (const mode of requiredModes[template.id]) {
      assert.ok(parsed.state.complexProblemMethod.includes(mode),
        `${template.id} AGENT.md must mention ${mode}`);
    }
  }
}

async function assertTemplateReselectionContract(): Promise<void> {
  await withVault(null, async ({ repository }) => {
    let llmAccesses = 0;
    const system = await createLocalCognitiveSystem(
      repository,
      1_700_000_000_000,
      () => { llmAccesses += 1; }
    );
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: {
        displayName: "小墨",
        avatar: Object.freeze({ kind: "default" as const })
      }
    });
    const memory = await repository.write({
      operation: "create",
      kind: "decision",
      title: "保留的决定",
      content: "模板切换不应改变这条 Memory。",
      recallWhen: "重新选择人格模板时",
      basis: "explicit",
      contentOrigin: "user_statement"
    } as never, {
      vaultId: await repository.readVaultId(),
      conversationId: "template-reselection",
      piSessionId: "template-reselection",
      productRunId: "template-reselection-memory",
      userEntryId: "template-reselection-user",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    assert.ok(memory.record);
    await system.settleDreamEnqueue();
    await system.applyAgentSelfOperations([
      {
        operation: "replace",
        field: "tone",
        value: "这是将被新模板替换的临时语气"
      },
      {
        operation: "habit_add",
        key: "preserve-evidence-habit",
        text: "重要判断保留可核对证据"
      }
    ]);

    const memoryBefore = await repository.inspect();
    const dreamBefore = await readFile(repository.layout.dreamState, "utf8");
    const identityBefore = await system.readAgentIdentity();
    const selected = await system.selectPersonalityTemplate("companion");
    const companion = agentSelfFromTemplate(getAgentTemplate("companion")!);
    assert.equal(selected.state.complexProblemMethod, companion.complexProblemMethod);
    assert.equal(selected.state.tone, companion.tone);
    assert.equal(selected.state.responseStructure, companion.responseStructure);
    assert.deepEqual(selected.state.currentLearnedHabits, [{
      key: "preserve-evidence-habit",
      text: "重要判断保留可核对证据"
    }]);
    assert.equal(selected.metadata.templateId, "companion");
    assert.equal(selected.identity.displayName, identityBefore.displayName);
    assert.equal(selected.identity.revision, identityBefore.revision);
    assert.equal(selected.identity.avatar.kind, identityBefore.avatar.kind);
    assert.deepEqual((await repository.inspect()).records, memoryBefore.records);
    assert.equal(await readFile(repository.layout.dreamState, "utf8"), dreamBefore);
    assert.equal(llmAccesses, 0, "template selection stays local and never calls a Provider");

    const controlBeforeNoop = await repository.readUserControlState();
    const metadataBeforeNoop = await readFile(repository.layout.agentSelfMetadata, "utf8");
    const noop = await system.selectPersonalityTemplate("companion");
    const controlAfterNoop = await repository.readUserControlState();
    assert.equal(noop.revision, controlBeforeNoop.revision);
    assert.equal(controlAfterNoop.revision, controlBeforeNoop.revision);
    assert.equal(controlAfterNoop.agent, controlBeforeNoop.agent);
    assert.equal(
      await readFile(repository.layout.agentSelfMetadata, "utf8"),
      metadataBeforeNoop,
      "selecting the current template is a zero-write no-op"
    );
  });
}

async function assertTemplateSelectionRejectsStaleAgentSnapshot(): Promise<void> {
  await withVault(null, async ({ repository }) => {
    const system = await createLocalCognitiveSystem(repository);
    await system.selectPersonalityTemplate("executor", {
      initialIdentity: {
        displayName: "小墨",
        avatar: Object.freeze({ kind: "default" as const })
      }
    });
    const snapshot = await system.readAgentSelfState();
    const concurrentAgent = replaceAgentCurrentSelf(
      snapshot.agent,
      applyAgentSelfOperations(snapshot.state, [{
        operation: "replace",
        field: "tone",
        value: "并发提交保留下来的新语气"
      }])
    );
    const originalApply = repository.applyCognitiveUpdate.bind(repository);
    let injected = false;
    repository.applyCognitiveUpdate = async (input) => {
      if (!injected) {
        injected = true;
        const current = await repository.readUserControlState();
        await repository.updateIdentityFile("agent", concurrentAgent, current.revision);
      }
      return await originalApply(input);
    };
    await assert.rejects(
      () => system.selectPersonalityTemplate("companion"),
      /revision conflict|projection conflict/iu
    );
    const after = await repository.readUserControlState();
    assert.equal(after.agent, concurrentAgent,
      "a stale template snapshot must never overwrite a newer AGENT commit");
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).read();
    assert.equal(metadata?.templateId, "executor");
  });
}

export async function runAgentSelfMigrationScenarios(): Promise<void> {
  assertFrozenAgentTemplates();
  const chineseKey = stableSelfKey("重要判断先给证据");
  assert.match(chineseKey, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.equal(chineseKey, stableSelfKey("重要判断先给证据"));
  assert.equal(stableSelfKey("Show evidence"), "show-evidence");
  assert.throws(() => normalizeAgentSelf({
    ...agentSelfFromTemplate(getAgentTemplate("advisor")!),
    currentLearnedHabits: [
      { key: "same-key", text: "第一条" },
      { key: "same-key", text: "第二条" }
    ]
  }), /habit_key_duplicate/u);

  const valid = currentAgent();
  assert.equal(parseAgentCurrentSelf(valid).kind, "ok");
  for (const invalid of [
    replaceHabitLine(valid, "- <!-- echoink:habit:bad_key --> 非法 key"),
    replaceHabitLine(valid, "- 普通但不受控的 bullet"),
    replaceHabitLine(valid, `${EMPTY_HABITS_SENTINEL}\n- <!-- echoink:habit:show-evidence --> 重要判断先给证据`),
    replaceHabitLine(valid, "- <!-- echoink:habit:show-evidence --> 重要判断先给证据\n- <!-- echoink:habit:show-evidence --> 重复"),
    `${valid}${"中".repeat(22_000)}`
  ]) {
    assert.equal(parseAgentCurrentSelf(invalid).kind, "invalid");
  }
  for (const [anchor, duplicate] of [
    ["遇到重要或复杂的问题时，我会：", "遇到重要或复杂的问题时，我会：重复方法。"],
    ["我的语气是：", "我的语气是：重复语气。"],
    ["我的回答通常会：", "我的回答通常会：重复结构。"]
  ] as const) {
    const line = valid.split("\n").find((candidate) => candidate.startsWith(anchor));
    assert.ok(line);
    assert.equal(
      parseAgentCurrentSelf(valid.replace(line, `${line}\n\n${duplicate}`)).kind,
      "invalid"
    );
  }

  for (const malicious of [
    "正常文本\n## 我怎样回答",
    "<!-- echoink:current-self:end -->",
    "<!-- echoink:habit:injected --> 注入"
  ]) {
    assert.throws(() => renderAgentMarkdown({
      styleName: "严谨睿智的顾问",
      self: {
        ...agentSelfFromTemplate(getAgentTemplate("advisor")!),
        tone: malicious
      }
    }), /agent_self_invalid|round_trip_failed/u);
    assert.throws(() => renderAgentMarkdown({
      styleName: "严谨睿智的顾问",
      self: {
        ...agentSelfFromTemplate(getAgentTemplate("advisor")!),
        currentLearnedHabits: [{ key: "malicious", text: malicious }]
      }
    }), /agent_self_invalid|round_trip_failed/u);
  }
  assert.throws(() => stableSelfKey(`bad${CURRENT_SELF_END}`), /control_syntax/u);

  let operated = applyAgentSelfOperations(agentSelfFromTemplate(getAgentTemplate("advisor")!), [
    { operation: "replace", field: "complex_problem_method", value: "先核对约束，再形成判断" },
    { operation: "replace", field: "tone", value: "冷静、明确" },
    { operation: "replace", field: "response_structure", value: "判断 → 依据 → 下一步" },
    { operation: "habit_add", key: "证据优先", text: "重要判断优先核对证据" }
  ]);
  assert.equal(operated.complexProblemMethod, "先核对约束，再形成判断");
  assert.equal(operated.currentLearnedHabits.length, 1);
  const operatedHabitKey = operated.currentLearnedHabits[0].key;
  assert.match(operatedHabitKey, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  operated = applyAgentSelfOperations(operated, [{
    operation: "habit_replace",
    key: operatedHabitKey,
    text: "重要判断给出可核对的依据"
  }]);
  assert.equal(operated.currentLearnedHabits[0].text, "重要判断给出可核对的依据");
  operated = applyAgentSelfOperations(operated, [{ operation: "habit_retire", key: operatedHabitKey }]);
  assert.equal(operated.currentLearnedHabits.length, 0);
  assert.throws(() => applyAgentSelfOperations(operated, [
    { operation: "replace", field: "tone", value: "第一项" },
    { operation: "replace", field: "tone", value: "第二项" }
  ]), /duplicate_target/u);
  assert.throws(() => applyAgentSelfOperations(operated, [{
    operation: "habit_replace", key: "missing", text: "不存在"
  }]), /habit_not_found/u);

  assert.equal(inspectLegacyAgentMarkdown(LEGACY_STATIC_AGENT).kind, "valid");
  assert.equal(inspectLegacyAgentMarkdown(legacyProjection(["重要判断先给证据"])).kind, "valid");
  const v1Inspection = inspectLegacyAgentMarkdown(legacyV1Projection(["先执行再汇报"]));
  assert.equal(v1Inspection.kind, "valid");
  if (v1Inspection.kind === "valid") assert.equal(v1Inspection.state.format, "personality_projection_v1");
  const v2Inspection = inspectLegacyAgentMarkdown(legacyProjection());
  assert.equal(v2Inspection.kind, "valid");
  if (v2Inspection.kind === "valid") assert.equal(v2Inspection.state.format, "personality_projection_v2");
  assert.equal(
    inspectLegacyAgentMarkdown(legacyProjection().replace(
      "- 锋利度（直接）：直接说明结论、依据和修改方式。",
      "- 节奏：偏右（快速）（80% 靠右极）"
    )).kind,
    "invalid"
  );
  assert.equal(inspectLegacyAgentMarkdown("# 用户自行写的 AGENT\n\n不要覆盖我。\n").kind, "invalid");

  await withVault(null, async ({ repository }) => {
    const before = await readFile(repository.layout.agent, "utf8");
    assert.equal(parseAgentCurrentSelf(before).kind, "ok");
    await migrate(repository);
    assert.equal(await readFile(repository.layout.agent, "utf8"), before);
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.equal(metadata.state.templateId, null);
  });

  const freshLegacyRequirement = "复杂任务先明确完成标准";
  const freshLegacyAgent = legacyProjection([freshLegacyRequirement]);
  await withVault(freshLegacyAgent, async ({ repository }) => {
    const source = await createTestMemory(repository, {
      title: "复杂任务完成标准",
      content: "以后处理复杂任务时先明确完成标准。",
      conversationId: "legacy-migration",
      productRunId: "legacy-migration-source"
    });
    assert.equal(source.id, "fresh-memory");
    const personalityBefore = await readFile(repository.layout.personalityState, "utf8");
    const identityBefore = await readOptionalUtf8(repository.layout.agentIdentity);
    const dreamBefore = await readOptionalUtf8(repository.layout.dreamState);
    const controlBefore = await repository.readUserControlState();
    const primaryBefore = await readFile(path.join(repository.layout.root, source.file), "utf8");
    await migrate(repository);
    const after = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(after.kind, "ok");
    if (after.kind === "ok") {
      assert.deepEqual(after.state.currentLearnedHabits.map((habit) => habit.text), [freshLegacyRequirement]);
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") {
      assert.equal(metadata.state.templateId, "advisor");
      assert.deepEqual(metadata.state.derivations, [{
        target: `habit:${stableSelfKey(freshLegacyRequirement)}`,
        operation: "habit_add",
        basis: "explicit",
        sources: [{
          kind: "memory",
          id: source.id,
          revision: source.revision,
          contextId: "task:legacy-migration-source",
          evidence: source.content
        }],
        previousValue: null,
        currentValue: freshLegacyRequirement,
        updatedAt: 1_700_000_000_000
      }]);
    }
    const controlAfter = await repository.readUserControlState();
    assert.equal(await readFile(repository.layout.personalityState, "utf8"), personalityBefore,
      "legacy personality bytes remain read-only during migration");
    assert.equal(
      await readFile(path.join(repository.layout.root, legacyAgentBackupRelativePath(freshLegacyAgent)), "utf8"),
      freshLegacyAgent,
      "the real legacy AGENT projection remains recoverable"
    );
    assert.equal(await readOptionalUtf8(repository.layout.agentIdentity), identityBefore);
    assert.equal(await readOptionalUtf8(repository.layout.dreamState), dreamBefore);
    assert.equal(controlAfter.user, controlBefore.user);
    assert.deepEqual(controlAfter.records, controlBefore.records,
      "migration must not rewrite primary Memory truth");
    assert.equal(await readFile(path.join(repository.layout.root, source.file), "utf8"), primaryBefore);

    await repository.write({
      operation: "supersede",
      targetId: source.id,
      title: "复杂任务完成标准已修正",
      content: "复杂任务先确认当前约束，再决定完成标准。",
      recallWhen: "需要延续长期协作方式时",
      basis: "explicit",
      contentOrigin: "confirmed_change",
      reason: "用户修正旧长期要求"
    }, {
      vaultId: "vault-agent-self-test",
      conversationId: "legacy-correction",
      piSessionId: "session-legacy-correction",
      productRunId: "legacy-correction-run",
      userEntryId: "entry-legacy-correction",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    const corrected = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(corrected.kind, "ok");
    if (corrected.kind === "ok") {
      assert.equal(corrected.state.currentLearnedHabits.some(
        (habit) => habit.text === freshLegacyRequirement
      ), false, "correcting the source Memory retracts the migrated habit");
    }
  }, {
    idFactory: sequentialMemoryIds("fresh-memory", "fresh-memory-replacement"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 2,
      templateId: "advisor",
      learnedRequirements: [{
        id: "fresh-legacy-requirement",
        text: freshLegacyRequirement,
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: ["fresh-memory"],
        revision: 1
      }]
    }
  });

  const forgottenLegacyRequirement = "长期复盘时保留失败证据";
  await withVault(legacyProjection([forgottenLegacyRequirement]), async ({ repository }) => {
    const source = await createTestMemory(repository, {
      title: "失败证据",
      content: "以后复盘时保留失败证据。",
      conversationId: "legacy-forget",
      productRunId: "legacy-forget-source"
    });
    await migrate(repository);
    let parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === forgottenLegacyRequirement
      ), true);
    }
    await repository.write({
      operation: "forget",
      targetId: source.id,
      reason: "用户明确要求忘记这项旧偏好",
      explicitForget: true
    }, {
      vaultId: "vault-agent-self-test",
      conversationId: "legacy-forget",
      piSessionId: "session-legacy-forget",
      productRunId: "legacy-forget-run",
      userEntryId: "entry-legacy-forget",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === forgottenLegacyRequirement
      ), false, "forgetting the source Memory retracts the migrated habit");
    }
  }, {
    idFactory: sequentialMemoryIds("forgotten-memory"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 4,
      templateId: "advisor",
      learnedRequirements: [{
        id: "forgotten-legacy-requirement",
        text: forgottenLegacyRequirement,
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: ["forgotten-memory"],
        revision: 1
      }]
    }
  });

  const underSupportedObservedRequirement = "复盘时主动寻找反例";
  await withVault(legacyProjection([underSupportedObservedRequirement]), async ({ repository }) => {
    await createTestMemory(repository, {
      title: "反例习惯一",
      content: "一次公开经历中观察到反例检查。",
      conversationId: "observed-one",
      productRunId: "same-observed-run"
    });
    await createTestMemory(repository, {
      title: "反例习惯二",
      content: "同一任务里的第二条观察。",
      conversationId: "observed-two",
      productRunId: "same-observed-run"
    });
    await migrate(repository);
    const parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === underSupportedObservedRequirement
      ), false, "two Memories from one ProductRun are not independent inferred evidence");
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.deepEqual(metadata.state.derivations, []);
  }, {
    idFactory: sequentialMemoryIds("observed-memory-one", "observed-memory-two"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 5,
      templateId: "advisor",
      learnedRequirements: [{
        id: "under-supported-observed-requirement",
        text: underSupportedObservedRequirement,
        basis: "observed_memory",
        status: "current",
        sourceMemoryIds: ["observed-memory-one", "observed-memory-two"],
        revision: 1
      }]
    }
  });

  const supportedObservedRequirement = "重要结论前检查反例";
  await withVault(legacyProjection([supportedObservedRequirement]), async ({ repository }) => {
    const first = await createTestMemory(repository, {
      title: "反例检查一",
      content: "一次独立任务中观察到重要结论前检查反例。",
      conversationId: "supported-observed-one",
      productRunId: "supported-observed-run-one"
    });
    const second = await createTestMemory(repository, {
      title: "反例检查二",
      content: "另一次独立任务中再次观察到反例检查。",
      conversationId: "supported-observed-two",
      productRunId: "supported-observed-run-two"
    });
    await migrate(repository);
    let parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === supportedObservedRequirement
      ), true);
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") {
      assert.equal(metadata.state.derivations.length, 1);
      assert.equal(metadata.state.derivations[0]?.basis, "inferred");
      assert.deepEqual(
        metadata.state.derivations[0]?.sources.map((source) => source.id),
        [first.id, second.id]
      );
    }

    await repository.write({
      operation: "forget",
      targetId: first.id,
      reason: "撤销其中一个独立观察来源",
      explicitForget: true
    }, {
      vaultId: "vault-agent-self-test",
      conversationId: "supported-observed-forget",
      piSessionId: "session-supported-observed-forget",
      productRunId: "supported-observed-forget-run",
      userEntryId: "entry-supported-observed-forget",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === supportedObservedRequirement
      ), false, "observed legacy habit retracts when independent sources fall below two"
      );
    }
  }, {
    idFactory: sequentialMemoryIds("supported-observed-one", "supported-observed-two"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 6,
      templateId: "advisor",
      learnedRequirements: [
        {
          id: "supported-observed-requirement-one",
          text: supportedObservedRequirement,
          basis: "observed_memory",
          status: "current",
          sourceMemoryIds: ["supported-observed-one"],
          revision: 1
        },
        {
          id: "supported-observed-requirement-two",
          text: supportedObservedRequirement,
          basis: "observed_memory",
          status: "current",
          sourceMemoryIds: ["supported-observed-two"],
          revision: 2
        }
      ]
    }
  });

  const staleLegacyRequirement = "重要判断前先查旧记录";
  await withVault(legacyProjection([staleLegacyRequirement]), async ({ repository }) => {
    const stale = await createTestMemory(repository, {
      title: "已失效的旧要求",
      content: "重要判断前先查旧记录。",
      conversationId: "stale-legacy-source",
      productRunId: "stale-legacy-source-run"
    });
    await repository.write({
      operation: "forget",
      targetId: stale.id,
      reason: "迁移前已明确撤销",
      explicitForget: true
    }, {
      vaultId: "vault-agent-self-test",
      conversationId: "stale-legacy-forget",
      piSessionId: "session-stale-legacy-forget",
      productRunId: "stale-legacy-forget-run",
      userEntryId: "entry-stale-legacy-forget",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    await migrate(repository);
    const parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === staleLegacyRequirement
      ), false, "a projected habit with no current source must not migrate"
      );
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.deepEqual(metadata.state.derivations, []);
  }, {
    idFactory: sequentialMemoryIds("stale-legacy-memory"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 7,
      templateId: "advisor",
      learnedRequirements: [{
        id: "stale-legacy-requirement",
        text: staleLegacyRequirement,
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: ["stale-legacy-memory"],
        revision: 1
      }]
    }
  });

  const supersededLegacyRequirement = "输出前核对关键事实";
  await withVault(legacyProjection([supersededLegacyRequirement]), async ({ repository }) => {
    await migrate(repository);
    const parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.equal(parsed.state.currentLearnedHabits.some(
        (habit) => habit.text === supersededLegacyRequirement
      ), false, "a superseded matching requirement removes the projected legacy habit");
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.deepEqual(metadata.state.derivations, []);
  }, {
    personality: {
      schema: "echoink.personality.v2",
      revision: 8,
      templateId: "advisor",
      learnedRequirements: [{
        id: "superseded-legacy-requirement",
        text: supersededLegacyRequirement,
        basis: "explicit_memory",
        status: "superseded",
        sourceMemoryIds: ["superseded-legacy-memory"],
        revision: 2
      }]
    }
  });

  const currentWithoutMetadata = currentAgent();
  await withVault(currentWithoutMetadata, async ({ repository }) => {
    await migrate(repository);
    assert.equal(await readFile(repository.layout.agent, "utf8"), currentWithoutMetadata);
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.equal(metadata.state.templateId, "advisor");
  });

  const exactAgent = padAgentToBytes(currentAgent(), AGENT_MD_HARD_MAX_BYTES);
  const overAgent = exactAgent.replace(/\n$/u, "x\n");
  const exactUser = padUserToBytes(defaultUserProfile(), USER_MD_HARD_MAX_BYTES);
  const overUser = exactUser.replace(/\n$/u, "中\n");
  assert.equal(Buffer.byteLength(exactAgent, "utf8"), AGENT_MD_HARD_MAX_BYTES);
  assert.equal(Buffer.byteLength(overAgent, "utf8"), AGENT_MD_HARD_MAX_BYTES + 1);
  assert.equal(Buffer.byteLength(exactUser, "utf8"), USER_MD_HARD_MAX_BYTES);
  assert.equal(Buffer.byteLength(overUser, "utf8"), USER_MD_HARD_MAX_BYTES + 3);
  assert.ok(overUser.length < USER_MD_HARD_MAX_BYTES,
    "multi-byte overflow must not be mistaken for a safe character count");
  assert.equal(parseAgentCurrentSelf(exactAgent).kind, "ok");
  assert.equal(parseAgentCurrentSelf(overAgent).kind, "invalid");
  await withVault(currentAgent(), async ({ repository }) => {
    const first = await repository.readUserControlState();
    await repository.updateIdentityFile("agent", exactAgent, first.revision);
    const second = await repository.readUserControlState();
    assert.equal(Buffer.byteLength(second.agent, "utf8"), AGENT_MD_HARD_MAX_BYTES);
    await repository.updateIdentityFile("user", exactUser, second.revision);
    const third = await repository.readUserControlState();
    assert.equal(Buffer.byteLength(third.user, "utf8"), USER_MD_HARD_MAX_BYTES);
    await assert.rejects(
      () => repository.updateIdentityFile("agent", overAgent, third.revision),
      /exceeds 65536 UTF-8 bytes/u
    );
    await assert.rejects(
      () => repository.updateIdentityFile("user", overUser, third.revision),
      /exceeds 131072 UTF-8 bytes/u
    );
    const unchanged = await repository.readUserControlState();
    assert.equal(unchanged.agent, exactAgent);
    assert.equal(unchanged.user, exactUser);
  });

  const noPersonalityAgent = legacyProjection(["重要判断先给证据"]);
  await withVault(noPersonalityAgent, async ({ repository }) => {
    await migrate(repository);
    const migrated = await readFile(repository.layout.agent, "utf8");
    const parsed = parseAgentCurrentSelf(migrated);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.deepEqual(parsed.state.currentLearnedHabits.map((habit) => habit.text), ["重要判断先给证据"]);
    }
    assert.equal(
      await readFile(path.join(repository.layout.root, legacyAgentBackupRelativePath(noPersonalityAgent)), "utf8"),
      noPersonalityAgent
    );
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") {
      assert.equal(metadata.state.templateId, "advisor");
      assert.equal(metadata.state.legacyPersonalityImported, false);
    }
  });

  const duplicateRequirement = "长期判断要先核对证据";
  await withVault(legacyProjection([duplicateRequirement]), async ({ repository }) => {
    await createTestMemory(repository, {
      title: "证据习惯一",
      content: "以后做长期判断时先核对证据。",
      conversationId: "duplicate-one",
      productRunId: "duplicate-one-run"
    });
    await createTestMemory(repository, {
      title: "证据习惯二",
      content: "长期协作中再次明确了证据优先。",
      conversationId: "duplicate-two",
      productRunId: "duplicate-two-run"
    });
    await migrate(repository);
    const parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.deepEqual(parsed.state.currentLearnedHabits.map((habit) => habit.text), [duplicateRequirement]);
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") {
      assert.equal(metadata.state.derivations.length, 1);
      assert.equal(metadata.state.derivations[0]?.basis, "explicit");
      assert.deepEqual(
        metadata.state.derivations[0]?.sources.map((source) => source.id),
        ["memory-0", "memory-1"],
        "same-text legacy requirements merge all current explicit sources deterministically"
      );
    }
  }, {
    idFactory: sequentialMemoryIds("memory-0", "memory-1"),
    personality: {
      schema: "echoink.personality.v2",
      revision: 7,
      templateId: "advisor",
      learnedRequirements: [0, 1].map((index) => ({
        id: `requirement-${index}`,
        text: duplicateRequirement,
        basis: "explicit_memory",
        status: "current",
        sourceMemoryIds: [`memory-${index}`],
        revision: index + 1
      }))
    }
  });

  const v1Requirement = "先执行再汇报";
  await withVault(legacyV1Projection([v1Requirement]), async ({ repository }) => {
    await migrate(repository);
    const parsed = parseAgentCurrentSelf(await readFile(repository.layout.agent, "utf8"));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      assert.deepEqual(parsed.state.currentLearnedHabits.map((habit) => habit.text), [v1Requirement]);
    }
    const metadata = await new AgentSelfMetadataStore(repository.layout.root).inspect();
    assert.equal(metadata.kind, "valid");
    if (metadata.kind === "valid") assert.equal(metadata.state.templateId, "executor");
  }, {
    personality: {
      schema: "echoink.personality.v1",
      revision: 3,
      templateId: "executor",
      learnedRequirements: []
    }
  });

  const custom = "# 用户自行写的 AGENT\n\n不要覆盖我。\n";
  await withVault(custom, async ({ repository }) => {
    await assert.rejects(() => migrate(repository), /legacy_agent_invalid/u);
    assert.equal(await readFile(repository.layout.agent, "utf8"), custom);
    await assert.rejects(() => readFile(repository.layout.agentSelfMetadata, "utf8"), /ENOENT/u);
  });

  await withVault(LEGACY_STATIC_AGENT, async ({ vaultPath, repository }) => {
    await assert.rejects(() => migrate(repository), /agent_self_migration_blocked:transaction_failed/u);
    const reopened = new PersonalMemoryRepository({
      vaultPath,
      vaultId: "vault-agent-self-test",
      watchExternalChanges: false
    });
    await reopened.initialize();
    assert.equal(await readFile(reopened.layout.agent, "utf8"), LEGACY_STATIC_AGENT);
    await assert.rejects(() => readFile(reopened.layout.agentSelfMetadata, "utf8"), /ENOENT/u);
    await reopened.dispose();
  }, { failAfter: 3 });

  await withVault(LEGACY_STATIC_AGENT, async ({ vaultPath, repository }) => {
    const concurrent = new PersonalMemoryRepository({
      vaultPath,
      vaultId: "vault-agent-self-test",
      watchExternalChanges: false
    });
    await concurrent.initialize();
    const originalApply = repository.applyCognitiveUpdate.bind(repository);
    let injected = false;
    repository.applyCognitiveUpdate = async (input) => {
      if (!injected) {
        injected = true;
        const current = await concurrent.readUserControlState();
        await concurrent.updateIdentityFile("agent", currentAgent(), current.revision);
      }
      return await originalApply(input);
    };
    await assert.rejects(() => migrate(repository), /agent_self_migration_blocked:transaction_failed/u);
    assert.equal(await readFile(repository.layout.agent, "utf8"), currentAgent(),
      "stale migration snapshot must not overwrite the concurrent AGENT commit");
    await assert.rejects(() => readFile(repository.layout.agentSelfMetadata, "utf8"), /ENOENT/u);
    await concurrent.dispose();
  });

  await assertTemplateReselectionContract();
  await assertTemplateSelectionRejectsStaleAgentSnapshot();

  await withVault(null, async ({ vaultPath, repository }) => {
    const system = await createLocalCognitiveSystem(repository);
    await system.selectPersonalityTemplate("advisor", { initialIdentity: { displayName: "移动互通", avatar: { kind: "default" } } });
    const resolve = (file: string) => path.join(vaultPath, file);
    const adapter = {
      exists: async (file: string) => { try { await access(resolve(file)); return true; } catch { return false; } },
      read: (file: string) => readFile(resolve(file), "utf8"),
      write: async (file: string, text: string) => { await writeFile(resolve(file), text); },
      rename: (from: string, to: string) => rename(resolve(from), resolve(to)),
      remove: (file: string) => rm(resolve(file)), rmdir: (file: string) => rm(resolve(file), { recursive: true }),
      mkdir: async (file: string) => { await mkdir(resolve(file), { recursive: true }); },
      list: async (file: string) => { const entries = await readdir(resolve(file), { withFileTypes: true }); return { files: entries.filter(e => e.isFile()).map(e => `${file}/${e.name}`), folders: entries.filter(e => e.isDirectory()).map(e => `${file}/${e.name}`) }; }
    } as DataAdapter;
    const mobile = new MobileProfileProtocol(adapter, () => 1_800_000_000_000, { read: () => "fixture-device", create: () => "fixture-device" });
    let profile = await mobile.profile();
    profile = await mobile.save({ identity: { displayName: "同源墨墨", avatar: { kind: "preset", presetId: "sol" } } }, profile.version);
    await mobile.save({ templateId: "executor" }, profile.version);
    const savedManifest = JSON.parse(await readFile(repository.layout.manifest, "utf8"));
    const reopened = new PersonalMemoryRepository({ vaultPath, vaultId: "vault-agent-self-test", watchExternalChanges: false });
    try {
      await reopened.initialize(); const fixed = await reopened.loadFixedContext({ memoryMode: "normal" });
      assert.equal(fixed.revision, savedManifest.revision); assert.ok(fixed.agent.includes("同源墨墨"));
      assert.ok(fixed.memory?.includes(`Revision: ${savedManifest.revision}`));
      const desktop = await createLocalCognitiveSystem(reopened);
      await desktop.updateAgentIdentity({ displayName: "桌面继续", avatar: { kind: "preset", presetId: "lin" } });
      assert.equal((await mobile.profile()).identity.displayName, "桌面继续");
    } finally { await reopened.dispose(); }
  });

  console.log("PASS agent-self: templates, reselection, strict round-trip and recoverable migration");
}
