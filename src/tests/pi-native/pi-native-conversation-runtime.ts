import { resolvePiTurnToolNames as resolveWorkspaceTools } from "../../harness/pi-native/pi-native-conversation-runtime";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  VERSION,
  type AgentSession,
  type SessionEntry,
  type AgentSessionEvent
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createControlledVaultResourceLoader } from "../../harness/pi-native/controlled-resources";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  ModelThinkingLevel,
  UserMessage
} from "@earendil-works/pi-ai";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { maintenanceSourceFingerprintsFromEntries } from "../../harness/pi-native/pi-knowledge-maintenance-tool";
import { createPiLocalConversation } from "../../harness/pi-native/pi-local-data-service";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import {
  PiNativeFileStoreError,
  piNativeVaultFileLayout
} from "../../harness/pi-native/file-store-utils";
import {
  PiNativeConversationRuntime,
  PiNativeConversationRuntimeError,
  type PiNativeAgentSessionFactoryInput,
  type PiNativeConversationRuntimeOptions,
  type PiNativeKnowledgeTurnContext,
  type PiNativeDocumentTurnContext,
  type PiNativeMemoryTurnContext,
  type PiNativeSkillTurnContext,
  type PiNativeTaskPlanTurnContext
} from "../../harness/pi-native/pi-native-conversation-runtime";
import type {
  PiChatPreparedImage,
  PiChatSubmitRequest,
  PiChatRuntimeEvent,
  PiKnowledgeRuntimePort,
  PiKnowledgeReference
} from "../../harness/pi-native/contracts";
import {
  PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE
} from "../../harness/pi-native/contracts";
import {
  PiSessionDurabilityError,
  type PiSessionManagerApi
} from "../../harness/pi-native/pi-session-durability";
import {
  appendTaskPlanEntry
} from "../../harness/pi-native/pi-task-plan";
import {
  PI_USER_QUESTION_TOOL_ID,
  PiUserQuestionToolSecurity
} from "../../harness/pi-native/pi-user-question-tool";
import {
  createPiVaultToolSecurityAdapter,
  PiVaultToolAuthorizationError
} from "../../harness/pi-native/pi-vault-tool-security-extension";
import {
  closeReasoningSummary,
  completeReasoningAtFirstText,
  createReasoningSummary,
  updateReasoningActivity
} from "../../harness/pi-native/pi-reasoning-summary";
import { routeKnowledgeConversationCommand } from "../../knowledge-base/commands";
import {
  createKnowledgeMaintenanceResultEnvelope
} from "../../knowledge-base/knowledge-maintenance-result";
import {
  FileKnowledgeUsageStore,
  KnowledgeUsageBridge,
  knowledgeReferenceEntryDetails
} from "../../knowledge-base/usage";
import {
  PI_CONTEXT_LEDGER_CUSTOM_TYPE,
  buildPiContextLedger,
  calculatePiEffectiveInputBudget
} from "../../harness/pi-native/pi-context-budget";
import {
  ECHOINK_TASK_PLAN_SCHEMA_VERSION,
  freezeEchoInkTaskPlan,
  latestTaskPlanFromBranch
} from "../../types/task-plan";
import {
  reasoningSummaryFromSessionEntry,
  type EchoInkReasoningSummarySnapshot
} from "../../types/reasoning-summary";
import { stableHashedIdentity } from "../../core/mapping";

const API: PiSessionManagerApi = {
  codingAgentVersion: VERSION,
  currentSessionVersion: CURRENT_SESSION_VERSION,
  open: (sessionFile, sessionRoot, cwdOverride) =>
    SessionManager.open(sessionFile, sessionRoot, cwdOverride)
};

const QUERY_MAINTENANCE_SCOPE = Object.freeze({
  mode: "query" as const,
  candidatePaths: Object.freeze(["raw/a.md"])
});

export async function runKnowledgeMaintenanceRuntimeTests(): Promise<void> {
  assertPersistedMaintenanceSourceVersions();
  await assertNaturalMaintenanceAndCorrection();
  await assertKnowledgeMaintenanceSettlementRequiresUniqueDurableResult();
  await assertTrustedKnowledgeMaintenanceResultsSurviveSettlementAndReopen();
  console.log("Pi maintenance natural completion, corrections, multiple submissions, trailing failure and durable reopen: PASS");
}

function assertPersistedMaintenanceSourceVersions(): void {
  const old = `sha256:${"a".repeat(64)}`;
  const refreshed = `sha256:12:${"b".repeat(64)}`;
  const entries = [
    { type: "message", message: { role: "toolResult", toolName: "note_read", isError: false, details: { references: [{ vaultRelativePath: "raw/a.md", contentRevision: old }] } } },
    { type: "message", message: { role: "toolResult", toolName: "knowledge_maintain", isError: true, details: { sourceBodyFingerprints: { "raw/a.md": refreshed } } } },
    { type: "message", message: { role: "toolResult", toolName: "knowledge_read", isError: false, details: { references: [{ vaultRelativePath: "raw/b.md", contentRevision: old }] } } }
  ] as unknown as SessionEntry[];
  assert.deepEqual(maintenanceSourceFingerprintsFromEntries(entries), { "raw/a.md": refreshed, "raw/b.md": old });
}

async function assertNaturalMaintenanceAndCorrection(): Promise<void> {
  await withFixture(["run-natural", "run-context", "run-corrected", "run-readonly", "run-parameter-error"], async (fixture) => {
    fixture.configureFactoryTools({ registered: ["vault_search", "note_read", "knowledge_maintain"], defaults: [], planAllowed: [] });
    const conversationId = "natural-maintenance";
    await createAndActivateMaintenanceConversation(fixture, conversationId);
    const natural = await fixture.submit({ conversationId, text: "/maintain", maintenanceScope: { mode: "batch", sourcePaths: ["raw/a.md", "raw/unread.md"] }, submittedAt: 3 });
    fixture.latestSession().finishTool("read-natural", "note_read", { details: { type: "echoink.knowledge-references.v1", schemaVersion: 1, references: [{ vaultRelativePath: "raw/a.md" }] } }, false);
    fixture.latestSession().finishSuccessful("这篇内容已检查，无需增加知识笔记。");
    const completed = await natural.result;
    assert.equal(completed.terminalState, "completed");
    assert.deepEqual(completed.maintenance?.processedSourcePaths, ["raw/a.md"]);
    assert.deepEqual(completed.maintenance?.pendingSourcePaths, ["raw/unread.md"]);
    const context = await fixture.submit({ conversationId, text: "/maintain", maintenanceScope: { mode: "batch", sourcePaths: ["raw/a.md"] }, submittedAt: 4 });
    fixture.latestSession().finishSuccessful("沿用已提供的正文，无需新增。");
    assert.equal((await context.result).terminalState, "completed");
    const corrected = await fixture.submit({ conversationId, text: "/maintain", maintenanceScope: { mode: "batch", sourcePaths: ["raw/a.md"] }, submittedAt: 5 });
    fixture.latestSession().finishTool("failed-candidate", "knowledge_maintain", { details: { status: "failed", maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "failed", issues: [{ code: "proposal_invalid", message: "bad candidate" }] }) } }, true);
    fixture.latestSession().finishTool("corrected-candidate", "knowledge_maintain", { details: { status: "completed", processedSourcePaths: ["raw/a.md"], maintenanceResult: createKnowledgeMaintenanceResultEnvelope({ status: "noop" }) } }, false);
    fixture.latestSession().finishSuccessful("已纠正。");
    assert.equal((await corrected.result).terminalState, "completed");
    const readonly = await fixture.submit({ conversationId, text: "/maintain", permission: "read-only", maintenanceScope: { mode: "batch", sourcePaths: ["raw/a.md", "raw/unread.md"] }, submittedAt: 6 });
    fixture.latestSession().finishSuccessful("沿用当前内容做只读分析。");
    const readonlyResult = await readonly.result;
    assert.equal(readonlyResult.maintenance?.analysisOnly, true);
    assert.deepEqual(readonlyResult.maintenance?.processedSourcePaths, ["raw/a.md"]);
    assert.deepEqual(readonlyResult.maintenance?.pendingSourcePaths, ["raw/unread.md"]);
    const invalid = await fixture.submit({ conversationId, text: "/maintain", maintenanceScope: { mode: "batch", sourcePaths: ["raw/a.md"] }, submittedAt: 7 });
    fixture.latestSession().finishTool("parameter-error", "knowledge_maintain", { content: [{ type: "text", text: "参数 candidateActions 无效，权限拒绝 api_key=sk-fixture-secret" }] }, true);
    fixture.latestSession().finishSuccessful("工具未能执行。");
    assert.equal((await invalid.result).terminalState, "failed");
    const failed = await fixture.productRuns.read(invalid.productRunId);
    assert.match(failed?.error ?? "", /参数 candidateActions 无效，权限拒绝/u);
    assert.doesNotMatch(failed?.error ?? "", /sk-fixture-secret/u);
  }, { knowledge: maintenanceKnowledgeFixture() });
}

export async function runPiNativeConversationRuntimeTests(): Promise<void> {
  await assertWorkspacePermissionsAndLateSources();
  await assertConversationDefaultSkillPriorityAndTurnContext();
  await assertRuntimeAutoSkillSelectionAndReviewLifecycle();
  await assertFreshnessRoutesExternalReadToolsAcrossWorkflows();
  await assertRelatedNormalChatPreflightsAndReadsKnowledge();
  await assertZeroReferenceNormalChatSkipsUsageAndSettles();
  await assertKnowledgeUsageFailureRemainsTerminal();
  await assertVaultWritesUseExistingApproval();
  await assertUserQuestionUsesCentralFailClosedSecurity();
  assertReasoningSummaryLifecycleSemantics();
  await assertReasoningSummaryRuntimeLifecycle();
  await assertProviderReasoningUsesPerAssistantMessageClocks();
  await assertReasoningSelectionFailsClosedBeforePiPrompt();
  assertKnowledgeMaintenanceRequiresExplicitCommand();
  await assertProjectionAndCatalogManagementStayAgentSessionFree();
  await assertSwitchPreservesRunningConversationUntilSettlement();
  await runPiNativeConcurrentSessionTests();
  await assertConversationCreateRollsBackAfterCatalogReadbackFailure();
  await assertFailedAssistantHistoryIsDurableButExcludedFromMemory();
  await assertKnowledgeAskUsesAgentAndReadOnlyTools();
  await assertAskSourceAttributionCapturesOnlyInjectedPrimaryMemory();
  await assertKnowledgeObservationAndProgressArePrivacySafe();
  await assertKnowledgeMaintenancePreferenceSnapshotIsTurnBound();
  await assertKnowledgeMaintenanceSettlementRequiresUniqueDurableResult();
  await assertTrustedKnowledgeMaintenanceResultsSurviveSettlementAndReopen();
  await runPiNativeDurableSettlementProjectionRegressionTest();
  await assertAgentSessionWarningsUseConversationSupport();
  await assertSkillPromptAndBindingValidation();
  await assertDurableDraftRequiresExplicitSuccessfulResubmission();
  await assertImagePromptsRequireCapabilityAndPreserveOrder();
  await assertDocumentSnapshotsAreTurnBoundAndValidatedBeforePrompt();
  await assertVerifiedPrefixRecoveryIsExplicitAndFailClosed();
  await assertExperienceSourceRefsArePointerOnlyAndDeleteAware();
  await assertMemoryTurnIsAvailableBeforeUserEntryPersistence();
  await assertUserEntryReadbackFailureIsSafelyDiagnosed();
  await assertDraftRemoveFailureIsSafelyDiagnosed();
  await assertProductRunCreateFailureCleansRuntime();
  await assertProductRunMarkRunningFailureCleansRuntime();
  await assertProductRunStartDiagnosticFailureDoesNotMaskCause();
  await assertTamperedProductRunStartCodesAreRedacted();
  await assertSuccessfulProductRunDoesNotWriteStartDiagnostic();
  await assertSubscriberFailuresAreIsolated();
  await assertSettlementFailureIsDiagnosedAndReleasesRun();
  await assertPromptStartFailureReleasesSettlementBarrier();
  await assertConversationTeardownWaitsForSettlement("release");
  await assertConversationTeardownWaitsForSettlement("shutdown");
  await assertConversationDerivationCreatesIndependentDurablePrefixes();
  await assertDerivationExcludesIdentityBoundOperationalState();
  await assertDerivedActivationFailureRemainsAVisibleDurableConversation();
  await runPiNativeTaskPlanRuntimeTests();
}

async function assertConversationDefaultSkillPriorityAndTurnContext(): Promise<void> {
  const resolvedIds: string[] = [];
  const automaticSelections: string[] = [];
  let revision = "a".repeat(64);
  let defaultSkillUnavailable = false;
  await withFixture([
    "run-default-skill-first",
    "run-default-skill-revised",
    "run-explicit-skill"
  ], async (fixture) => {
    const conversationId = "conversation-default-daily-journal";
    await createPiLocalConversation({
      catalog: fixture.catalog,
      sessionApi: API
    }, {
      conversationId,
      title: "Default daily journal",
      cwd: fixture.root,
      defaultSkillId: "daily-journal",
      journalDirectory: "notes/daily",
      createdAt: 1
    });
    const submittedAt = new Date(2026, 8, 4, 9, 7).getTime();
    const first = await fixture.submit({
      conversationId,
      text: "想把今天发生的事记下来。",
      submittedAt
    });
    assert.deepEqual(resolvedIds, ["daily-journal"]);
    assert.deepEqual(automaticSelections, []);
    assert.equal(fixture.sessions.length, 1);
    assert.deepEqual(fixture.currentSkillTurn(), {
      skillId: "daily-journal",
      content: [
        "当前使用 daily-journal Skill。直接交流，用户继续表达时继续聊；开场不检查文件、模板或目录。",
        "用户明确要保存时，再调用 obsidian_context 获取当前原生日记设置、当天精确路径和已渲染模板，使用现有 note 工具保存。"
      ].join("\n")
    });
    assert.match(
      fixture.latestSession().promptTexts[0] ?? "",
      /^<skill name="daily-journal">fixture procedure<\/skill>\n\n想把今天发生的事记下来。$/u
    );
    fixture.latestSession().finishSuccessful("先聊聊今天发生的事");
    assert.equal((await first.result).terminalState, "completed");
    const firstProjection = await fixture.runtime.readProjection(conversationId);
    assert.deepEqual(
      firstProjection.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["想把今天发生的事记下来。"],
      "the internal daily-journal procedure must not appear in Conversation UI"
    );

    revision = "b".repeat(64);
    const second = await fixture.submit({
      conversationId,
      text: "我准备好补记了。",
      submittedAt: submittedAt + 60_000
    });
    assert.deepEqual(resolvedIds, ["daily-journal", "daily-journal"]);
    assert.equal(
      fixture.sessions.length,
      2,
      "editing the default Skill invalidates the cached AgentSession on the next turn"
    );
    fixture.latestSession().finishSuccessful("已经准备补记");
    assert.equal((await second.result).terminalState, "completed");

    const explicit = await fixture.submit({
      conversationId,
      text: "这一轮使用我明确选择的 Skill。",
      submittedAt: submittedAt + 120_000,
      skillPath: "/fixture/skills/explicit/SKILL.md",
      skillName: "explicit-skill"
    });
    assert.deepEqual(
      resolvedIds,
      ["daily-journal", "daily-journal"],
      "an explicit per-turn Skill takes priority over the Conversation default"
    );
    assert.equal(fixture.currentSkillTurn(), null);
    assert.equal(
      fixture.latestSession().promptTexts[0],
      "/skill:explicit-skill 这一轮使用我明确选择的 Skill。"
    );
    fixture.latestSession().finishSuccessful("显式 Skill 已执行");
    assert.equal((await explicit.result).terminalState, "completed");

    const unavailableConversationId = "conversation-default-skill-unavailable";
    await fixture.runtime.createConversation({
      conversationId: unavailableConversationId,
      title: "Unavailable default Skill",
      cwd: fixture.root,
      defaultSkillId: "daily-journal",
      journalDirectory: "notes/daily",
      createdAt: 2
    });
    defaultSkillUnavailable = true;
    const sessionCountBeforeFailure = fixture.sessions.length;
    await assert.rejects(
      fixture.submit({
        conversationId: unavailableConversationId,
        text: "这轮不应触发 Provider。",
        submittedAt: submittedAt + 180_000
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "skill_binding_invalid"
    );
    assert.equal(
      fixture.sessions.length,
      sessionCountBeforeFailure,
      "default Skill failure happens before createAgentSession and Provider preparation"
    );
  }, {
    skills: {
      selectForTask: async ({ text }) => {
        automaticSelections.push(text);
        return null;
      },
      resolveById: async ({ id }) => {
        resolvedIds.push(id);
        if (defaultSkillUnavailable) throw new Error("fixture_skill_disabled");
        const selected = Object.freeze({
          id,
          skillPath: `/fixture/skills/${id}/SKILL.md`,
          skillName: id
        });
        return Object.freeze({
          ...selected,
          revision,
          skills: Object.freeze([selected]),
          applicableSkillIds: Object.freeze([id]),
          requiresFreshnessVerification: false
        });
      },
      recordUse: async () => undefined,
      reviewCompletedTask: async () => undefined
    }
  });
}

async function assertFreshnessRoutesExternalReadToolsAcrossWorkflows(): Promise<void> {
  let reviewCount = 0;
  let usageCount = 0;
  const oldRecordedAt = Date.UTC(2024, 0, 1);
  const referenceFor = (
    title: string,
    excerpt: string,
    suffix: string
  ): Readonly<PiKnowledgeReference> => Object.freeze({
    referenceId: `knowledge-reference:${suffix.repeat(64)}`,
    vaultRelativePath: `wiki/${suffix}.md`,
    title,
    excerpt,
    contentRevision: `sha256:${suffix.repeat(64)}`,
    lineStart: 1,
    lineEnd: 1,
    sourceType: "wiki" as const,
    recordedAt: oldRecordedAt,
    publishedAt: "2024-01-01",
    verificationStatus: "local_revision_verified" as const
  });
  const oldFastReference = referenceFor(
    "AI SDK 版本说明",
    "这份 AI 产品 API 说明记录于旧版本。",
    "c"
  );
  const oldStableReference = referenceFor(
    "勾股定理",
    "直角三角形两直角边平方和等于斜边平方。",
    "d"
  );
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveChat(input) {
      const reference = /AI SDK/u.test(input.question)
        ? oldFastReference
        : /勾股定理/u.test(input.question)
          ? oldStableReference
          : null;
      if (reference) {
        return Object.freeze({
          status: "ready" as const,
          references: Object.freeze([reference]),
          providerResourceText: "OLD_KNOWLEDGE_REFERENCE",
          retrieval: Object.freeze({
            elapsedMs: 1,
            total: 1,
            returned: 1,
            remaining: 0,
            hasMore: false,
            exhausted: true
          })
        });
      }
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "NO_PERSONAL_EVIDENCE",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 0,
          returned: 0,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async retrieveAsk() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "NO_ASK_EVIDENCE",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 0,
          returned: 0,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async prepareMaintenancePreferences() {
      return Object.freeze({
        profileVersion: "echoink-knowledge-preference-profile-v1",
        state: "default" as const,
        revision: `sha256:${"a".repeat(64)}`,
        providerResourceText: "DEFAULT_PREFERENCE"
      });
    }
  };
  const skills: NonNullable<PiNativeConversationRuntimeOptions["skills"]> = {
    async selectForTask({ text }) {
      if (!/最新|当前|核验/u.test(text)) return null;
      const selected = Object.freeze({
        id: "evidence-freshness-audit",
        skillPath: "/fixture/skills/evidence-freshness-audit/SKILL.md",
        skillName: "evidence-freshness-audit"
      });
      return Object.freeze({
        ...selected,
        revision: "f".repeat(64),
        skills: Object.freeze([selected]),
        applicableSkillIds: Object.freeze([selected.id]),
        requiresFreshnessVerification: true
      });
    },
    async recordUse() { usageCount += 1; },
    async reviewCompletedTask() { reviewCount += 1; }
  };
  await withFixture([
    "run-freshness-chat",
    "run-stable-chat",
    "run-old-fast-chat",
    "run-old-stable-chat",
    "run-freshness-ask",
    "run-freshness-maintain"
  ], async (fixture) => {
    fixture.configureFactoryTools({
      registered: [
        "vault_search",
        "note_read",
        "knowledge_search",
        "knowledge_read",
        "knowledge_maintain",
        "external_read"
      ],
      defaults: ["vault_search", "note_read", "knowledge_search", "knowledge_read", "knowledge_maintain", "external_read"],
      planAllowed: [],
      externalReadAllowed: ["external_read"]
    });
    const conversationId = "freshness-tool-routing";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Freshness routing",
      cwd: fixture.root,
      defaultMemoryMode: "no_memory",
      createdAt: 1
    });

    const chat = await fixture.submit({
      conversationId,
      text: "根据我的笔记核验当前 AI 价格",
      memoryMode: "no_memory",
      submittedAt: 2
    });
    let session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true);
    session.finishSuccessful("已核验");
    await chat.result;

    const stable = await fixture.submit({
      conversationId,
      text: "根据我的笔记总结稳定的项目结构",
      memoryMode: "no_memory",
      submittedAt: 3
    });
    session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true,
      "already admitted external reads remain available in ordinary Chat");
    session.finishSuccessful("已总结");
    await stable.result;

    const oldFast = await fixture.submit({
      conversationId,
      text: "AI SDK 怎么接入这个模型？",
      memoryMode: "no_memory",
      submittedAt: 4
    });
    session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true,
      "an old fast-changing Knowledge hit must enable freshness verification after preflight");
    session.finishSuccessful("需要核验当前版本");
    await oldFast.result;

    const oldStable = await fixture.submit({
      conversationId,
      text: "勾股定理怎么证明？",
      memoryMode: "no_memory",
      submittedAt: 5
    });
    session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true,
      "freshness does not control the external read allowlist");
    session.finishSuccessful("稳定知识仍可使用");
    await oldStable.result;

    const ask = await fixture.submit({
      conversationId,
      text: "/ask 核验最新 AI 价格",
      memoryMode: "no_memory",
      submittedAt: 6
    });
    session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true);
    session.finishSuccessful("已核验");
    await ask.result;

    const maintain = await fixture.submit({
      conversationId,
      text: "/maintain raw/a.md",
      memoryMode: "no_memory",
      maintenanceScope: QUERY_MAINTENANCE_SCOPE,
      submittedAt: 7
    });
    session = fixture.latestSession();
    assert.equal(session.activeToolSelections.at(-1)?.includes("external_read"), true);
    assert.equal(session.activeToolSelections.at(-1)?.includes("knowledge_maintain"), true);
    assert.deepEqual(fixture.currentSuccessfulExternalReadTools(), []);
    session.finishTool("failed-external-read", "external_read", {
      details: { status: "failed" }
    }, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(fixture.currentSuccessfulExternalReadTools(), [],
      "a failed external Tool result must not authorize external_verified");
    session.finishTool("successful-external-read", "external_read", {
      details: { status: "completed" }
    }, false);
    await waitForTestCondition(() =>
      fixture.currentSuccessfulExternalReadTools().includes("external_read")
    );
    session.finishSuccessful("未提交维护动作");
    await maintain.result;
    await waitForTestCondition(() => reviewCount === 4);
    assert.equal(usageCount, 1,
      "only the successful normal Chat may write Skill usage state");
    assert.equal(reviewCount, 4,
      "all normal Chats are reviewed, while ask and maintain never enter Skill learning");
  }, {
    knowledge,
    skills,
    now: () => Date.UTC(2026, 7, 30)
  });
}

async function assertRelatedNormalChatPreflightsAndReadsKnowledge(): Promise<void> {
  const reference: PiKnowledgeReference = Object.freeze({
    referenceId: `knowledge-reference:${"a".repeat(64)}`,
    vaultRelativePath: "projects/echoink.md",
    title: "EchoInk",
    excerpt: "项目决定优先使用个人知识。",
    contentRevision: `sha256:${"b".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1,
    sourceType: "projects",
    recordedAt: 1_700_000_000_000,
    publishedAt: "2026-08-30",
    verificationStatus: "local_revision_verified"
  });
  let usageBridge: KnowledgeUsageBridge | null = null;
  let usageCalls = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      throw new Error("ask_not_expected");
    },
    async retrieveChat(input) {
      assert.equal(input.question, "Transformer 位置编码是什么？");
      assert.deepEqual(input.explicitPaths, []);
      return Object.freeze({
        status: "ready" as const,
        references: Object.freeze([reference]),
        providerResourceText: "BOUNDED_PERSONAL_KNOWLEDGE_PREFLIGHT",
        retrieval: Object.freeze({
          elapsedMs: 5,
          total: 1,
          returned: 1,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      assert.deepEqual(input.references, [reference]);
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([reference])
      });
    },
    async recordUsage(input) {
      usageCalls += 1;
      assert.ok(usageBridge);
      const { personalMemorySources, ...event } = input.event;
      await usageBridge.record({
        event: {
          ...event,
          referenceIds: [...event.referenceIds],
          producedPaths: [...event.producedPaths],
          ...(personalMemorySources === undefined
            ? {}
            : {
                personalMemorySources: personalMemorySources.map(
                  (source) => ({ ...source })
                )
              })
        },
        entries: input.entries
      });
    }
  };
  await withFixture(["run-normal-knowledge-preflight"], async (fixture) => {
    const usageStore = new FileKnowledgeUsageStore({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await usageStore.initialize();
    usageBridge = new KnowledgeUsageBridge(usageStore);
    fixture.configureFactoryTools({
      registered: ["knowledge_search", "knowledge_read", "note_read"],
      defaults: ["knowledge_search", "knowledge_read", "note_read"],
      planAllowed: ["note_read"]
    });
    const run = await fixture.submit({
      conversationId: "normal-knowledge-preflight",
      text: "Transformer 位置编码是什么？",
      submittedAt: 1
    });
    const session = fixture.latestSession();
    assert.equal(session.knowledgeTurnsBeforeUserEntryAppend[0]?.kind, "chat");
    assert.deepEqual(
      session.knowledgeTurnsBeforeUserEntryAppend[0]?.references,
      [reference]
    );
    assert.equal(session.activeToolSelections.at(-1)?.includes("knowledge_search"), true);
    assert.equal(session.activeToolSelections.at(-1)?.includes("knowledge_read"), true);
    const referenceDetails = knowledgeReferenceEntryDetails([{ ...reference }]);
    const referenceEntryId = session.sessionManager.appendCustomMessageEntry(
      "echoink-knowledge-chat-resource-v1",
      "BOUNDED_PERSONAL_KNOWLEDGE_PREFLIGHT",
      false,
      referenceDetails
    );
    session.finishSuccessful("依据项目原文，当前决定是优先使用个人知识。");
    const settled = await run.result;
    assert.equal(settled.terminalState, "completed");
    assert.equal(usageCalls, 1);
    const recordedUsage = await usageStore.list({ conversationId: run.conversationId });
    assert.equal(recordedUsage.length, 1);
    assert.equal(recordedUsage[0]?.workflow, "normal_read");
    assert.deepEqual(recordedUsage[0]?.referenceIds, [reference.referenceId]);

    const sessionFile = session.sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(
      sessionFile,
      fixture.catalog.sessionRootPath,
      fixture.root
    );
    const durableReferenceEntry = reopened.getBranch().find(
      (entry) => entry.id === referenceEntryId
    );
    assert.equal(durableReferenceEntry?.type, "custom_message");
    if (durableReferenceEntry?.type === "custom_message") {
      assert.deepEqual(durableReferenceEntry.details, referenceDetails);
    }
    assert.equal(
      (await fixture.catalog.diagnostics(run.conversationId)).some(
        (diagnostic) => diagnostic.code === "runtime_interrupted"
      ),
      false
    );
  }, { knowledge });
}

async function assertZeroReferenceNormalChatSkipsUsageAndSettles(): Promise<void> {
  let verificationCalls = 0;
  let usageCalls = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveChat() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "NO_PERSONAL_KNOWLEDGE",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 0,
          returned: 0,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      verificationCalls += 1;
      assert.deepEqual(input.references, []);
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async recordUsage() {
      usageCalls += 1;
      throw new Error("empty_normal_read_must_not_be_recorded");
    }
  };
  await withFixture(["run-zero-reference-chat"], async (fixture) => {
    const conversationId = "zero-reference-chat";
    const run = await fixture.submit({
      conversationId,
      text: "普通 Chat 没有 Knowledge 引用",
      submittedAt: 1
    });
    const session = fixture.latestSession();
    session.finishSuccessful("正常完成回答。");

    const settled = await run.result;
    assert.equal(settled.state, "product_run_settled");
    assert.equal(settled.terminalState, "completed");
    assert.equal(verificationCalls, 1);
    assert.equal(usageCalls, 0);
    assert.equal(
      reasoningSummariesForRun(session.sessionManager, run.productRunId)
        .at(-1)?.status,
      "completed"
    );
    assert.equal(
      (await fixture.catalog.diagnostics(conversationId)).some(
        (diagnostic) => diagnostic.code === "runtime_interrupted"
      ),
      false
    );
  }, { knowledge });
}

async function assertKnowledgeUsageFailureRemainsTerminal(): Promise<void> {
  const reference: PiKnowledgeReference = Object.freeze({
    referenceId: `knowledge-reference:${"e".repeat(64)}`,
    vaultRelativePath: "wiki/usage-failure.md",
    title: "Usage failure",
    excerpt: "非空引用必须继续严格记账。",
    contentRevision: `sha256:${"f".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1
  });
  const usageFailure = new Error("fixture_knowledge_usage_store_failure");
  let usageCalls = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveChat() {
      return Object.freeze({
        status: "ready" as const,
        references: Object.freeze([reference]),
        providerResourceText: "NON_EMPTY_PERSONAL_KNOWLEDGE",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 1,
          returned: 1,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      assert.deepEqual(input.references, [reference]);
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([reference])
      });
    },
    async recordUsage() {
      usageCalls += 1;
      throw usageFailure;
    }
  };
  await withFixture(["run-knowledge-usage-failure"], async (fixture) => {
    const conversationId = "knowledge-usage-failure";
    const run = await fixture.submit({
      conversationId,
      text: "非空 Knowledge Usage 失败必须上抛",
      submittedAt: 1
    });
    fixture.latestSession().finishSuccessful("回答正文已经生成。");

    await assert.rejects(run.result, (error: unknown) => error === usageFailure);
    assert.equal(usageCalls, 1);
    assert.equal(
      (await fixture.catalog.diagnostics(conversationId)).some(
        (diagnostic) => diagnostic.code === "runtime_interrupted"
      ),
      true
    );
  }, { knowledge });
}

async function assertRuntimeAutoSkillSelectionAndReviewLifecycle(): Promise<void> {
  const selections: string[] = [];
  const uses: Array<Readonly<{ skillId: string; usedAt: number }>> = [];
  const reviews: Array<Readonly<{
    productRunId: string;
    result: string;
    terminalState: string;
    existingCapabilityIds: readonly string[];
  }>> = [];
  let releaseFirstReview!: () => void;
  const firstReviewGate = new Promise<void>((resolve) => {
    releaseFirstReview = resolve;
  });
  let activeFixture: RuntimeFixture | null = null;
  await withFixture([
    "run-auto-skill",
    "run-skill-review-failure",
    "run-method-only-skill-review"
  ], async (fixture) => {
    activeFixture = fixture;
    fixture.configureFactoryTools({
      registered: ["knowledge_read", "note_read"],
      defaults: ["knowledge_read", "note_read"],
      planAllowed: []
    });
    const first = await fixture.submit({
      conversationId: "skill-runtime",
      text: "请从第一性原理拆解这个复杂问题",
      submittedAt: 1
    });
    const session = fixture.latestSession();
    assert.equal(
      session.promptTexts[0],
      '<skill name="multi-lens-problem-solving">fixture procedure</skill>\n\n请从第一性原理拆解这个复杂问题'
    );
    session.finishTool("skill-used-read", "knowledge_read", {
      details: { status: "completed" }
    }, false);
    session.finishTool("skill-failed-read", "note_read", {
      details: { status: "failed" }
    }, true);
    session.finishSuccessful("已完成复杂问题拆解");
    const firstResult = await first.result;
    assert.equal(firstResult.terminalState, "completed");
    assert.deepEqual(selections, ["请从第一性原理拆解这个复杂问题"]);
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.skillId, "multi-lens-problem-solving");
    assert.deepEqual(reviews, [],
      "background Skill review cannot delay the settled ProductRun result");
    releaseFirstReview();
    await waitForTestCondition(() => reviews.length === 1);
    assert.deepEqual(reviews, [{
      productRunId: "run-auto-skill",
      result: "已完成复杂问题拆解",
      terminalState: "completed",
      existingCapabilityIds: [
        "knowledge_read",
        "skill:multi-lens-problem-solving"
      ]
    }]);

    const second = await fixture.submit({
      conversationId: "skill-runtime",
      text: "请复验这个复杂问题并模拟复盘失败",
      submittedAt: 2
    });
    fixture.latestSession().finishSuccessful("任务本身已经完成");
    const secondResult = await second.result;
    assert.equal(secondResult.terminalState, "completed",
      "post-task Skill review failure cannot reverse a completed ProductRun");
    await waitForTestCondition(async () =>
      (await fixture.catalog.diagnostics("skill-runtime"))
        .some((entry) => entry.message === "skill_review_failed")
    );
    const diagnostics = await fixture.catalog.diagnostics("skill-runtime");
    assert.equal(diagnostics.some((entry) => entry.message === "skill_review_failed"), true);

    const methodOnly = await fixture.submit({
      conversationId: "skill-runtime",
      text: "把这次讨论整理成可复用的纯方法",
      submittedAt: 3
    });
    const methodOnlySession = fixture.latestSession();
    assert.equal(
      methodOnlySession.promptTexts[0],
      "把这次讨论整理成可复用的纯方法",
      "a method-only task can run without a preselected Skill"
    );
    methodOnlySession.finishSuccessful("已整理为可复用的说明流程");
    assert.equal((await methodOnly.result).terminalState, "completed");
    await waitForTestCondition(() => reviews.length === 2);
    assert.deepEqual(reviews.at(-1), {
      productRunId: "run-method-only-skill-review",
      result: "已整理为可复用的说明流程",
      terminalState: "completed",
      existingCapabilityIds: []
    }, "a successful method-only Chat reaches non-blocking review with an empty capability set");
  }, {
    skills: {
      selectForTask: async ({ text }) => {
        selections.push(text);
        if (text.includes("纯方法")) return null;
        return Object.freeze({
          id: "multi-lens-problem-solving",
          skillPath: "/fixture/skills/multi-lens-problem-solving/SKILL.md",
          skillName: "multi-lens-problem-solving",
          revision: "e".repeat(64),
          skills: Object.freeze([Object.freeze({
            id: "multi-lens-problem-solving",
            skillPath: "/fixture/skills/multi-lens-problem-solving/SKILL.md",
            skillName: "multi-lens-problem-solving"
          })]),
          applicableSkillIds: Object.freeze(["multi-lens-problem-solving"]),
          requiresFreshnessVerification: false
        });
      },
      recordUse: async (skillId, usedAt) => {
        uses.push(Object.freeze({ skillId, usedAt }));
      },
      reviewCompletedTask: async (input) => {
        assert.ok(activeFixture);
        assert.equal(
          (await activeFixture.productRuns.read(input.productRunId))?.state,
          "product_run_settled",
          "Skill review starts only after the ProductRun is durably settled"
        );
        if (input.request.includes("模拟复盘失败")) {
          throw new Error("fixture_skill_review_failed");
        }
        if (input.productRunId === "run-auto-skill") await firstReviewGate;
        reviews.push(Object.freeze({
          productRunId: input.productRunId,
          result: input.result,
          terminalState: input.terminalState,
          existingCapabilityIds: Object.freeze([...input.existingCapabilityIds])
        }));
      }
    }
  });
}

async function assertDocumentSnapshotsAreTurnBoundAndValidatedBeforePrompt(): Promise<void> {
  await withFixture(["document-run", "document-replay-run"], async (fixture) => {
    const conversationId = "document-snapshot-turn";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Document snapshot turn",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    assert.equal(fixture.currentDocumentTurn(), null);

    await assert.rejects(fixture.submit({
      conversationId,
      text: "invalid document",
      submittedAt: 2,
      documents: [{
        kind: "pdf",
        text: "body",
        bytes: new Uint8Array([1]),
        sha256: createHash("sha256").update(new Uint8Array([1])).digest("hex"),
        transport: "native",
        attachment: {
          type: "file",
          name: "oversized.pdf",
          path: "/private/oversized.pdf",
          mimeType: "application/pdf",
          sizeBytes: 20 * 1024 * 1024 + 1,
          availability: "available"
        }
      }]
    }), /document snapshot is invalid/u);
    assert.deepEqual(session.promptTexts, []);

    const baselineEntryCount = session.sessionManager.getEntries().length;
    const largeDocumentBytes = new Uint8Array(Buffer.alloc(16 * 1024 * 1024, 9));
    const largeDocument = (index: number) => ({
      kind: "pdf" as const,
      bytes: largeDocumentBytes,
      sha256: createHash("sha256").update(largeDocumentBytes).digest("hex"),
      transport: "native" as const,
      attachment: {
        type: "file" as const,
        name: `large-${index}.pdf`,
        path: `/private/large-${index}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: largeDocumentBytes.byteLength,
        availability: "available" as const
      }
    });
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "must fail before user persistence",
        submittedAt: 3,
        documents: [largeDocument(1), largeDocument(2)]
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "document_request_too_large"
    );
    assert.deepEqual(
      session.promptTexts,
      [],
      "32 MiB preflight must run before AgentSession.prompt"
    );
    assert.equal(
      session.sessionManager.getEntries().length,
      baselineEntryCount,
      "32 MiB preflight must not persist a Pi user entry"
    );

    const documentBytes = new Uint8Array(Buffer.alloc(128, 7));
    const documents = [{
      kind: "markdown" as const,
      text: "PRIVATE_DOCUMENT_BODY",
      bytes: documentBytes,
      sha256: createHash("sha256").update(documentBytes).digest("hex"),
      transport: "extracted_text" as const,
      attachment: {
        type: "file" as const,
        name: "notes.md",
        path: "/private/local/notes.md",
        mimeType: "text/markdown",
        sizeBytes: 128,
        availability: "available" as const
      }
    }];
    const handle = await fixture.submit({
      conversationId,
      text: "总结文档",
      submittedAt: 4,
      documents
    });
    assert.deepEqual(fixture.currentDocumentTurn()?.documents, documents);
    assert.deepEqual(session.promptTexts, ["总结文档"]);
    session.finishSuccessful("done");
    await handle.result;
    assert.equal(fixture.currentDocumentTurn(), null);

    const replayHandle = await fixture.submit({
      conversationId,
      text: "重放冻结文档",
      submittedAt: 5,
      documents: [{
        ...documents[0]!,
        bytes: new Uint8Array(),
        transport: "extracted_text"
      }]
    });
    assert.equal(
      fixture.currentDocumentTurn()?.documents[0]?.bytes.byteLength,
      0,
      "reopen/resend may replay frozen text without persisted bytes"
    );
    assert.equal(
      fixture.currentDocumentTurn()?.documents[0]?.text,
      "PRIVATE_DOCUMENT_BODY"
    );
    session.finishSuccessful("replayed");
    await replayHandle.result;
  });
}

async function assertReasoningSelectionFailsClosedBeforePiPrompt(): Promise<void> {
  await withFixture(["reasoning-valid-run"], async (fixture) => {
    const conversationId = "reasoning-selection-validation";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Reasoning selection validation",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    let session = fixture.latestSession();
    const baselineEntries = session.sessionManager.getEntries().length;

    await assert.rejects(
      fixture.runtime.submit({
        conversationId,
        text: "缺失冻结身份不得进入 Pi",
        submittedAt: 2
      } as PiChatSubmitRequest),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "provider_execution_unbound"
    );
    await assert.rejects(
      fixture.runtime.submit({
        conversationId,
        text: "缺失冻结强度不得进入 Pi",
        submittedAt: 3,
        runtimeProviderId: "fixture-provider",
        modelId: "fixture-model"
      } as PiChatSubmitRequest),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "reasoning_level_invalid"
    );
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "人工五档模型不暴露 minimal 别名",
        submittedAt: 4,
        reasoning: "minimal"
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "reasoning_level_invalid"
    );
    assert.deepEqual(session.thinkingLevelChanges, []);
    assert.deepEqual(session.promptTexts, []);
    assert.equal(session.sessionManager.getEntries().length, baselineEntries);

    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "冻结身份不得漂移",
        submittedAt: 5,
        runtimeProviderId: "different-provider",
        modelId: "fixture-model",
        reasoning: "medium"
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "provider_execution_unbound"
    );
    assert.deepEqual(session.thinkingLevelChanges, []);
    assert.deepEqual(session.promptTexts, []);

    // A model change can replace the idle instance; this fixture intentionally
    // returns its fixed model so the request still fails identity validation.
    session = fixture.latestSession();
    const accepted = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const [index, reasoning] of accepted.entries()) {
      const valid = await fixture.submit({
        conversationId,
        text: `合法五档 ${reasoning} 进入 Pi`,
        submittedAt: 6 + index,
        runtimeProviderId: "fixture-provider",
        modelId: "fixture-model",
        reasoning
      });
      assert.equal(session.thinkingLevelChanges.at(-1), reasoning);
      session.finishSuccessful(`ok-${reasoning}`);
      await valid.result;
    }
    assert.deepEqual(session.thinkingLevelChanges, accepted);
  });

  await withFixture(["reasoning-none-run"], async (fixture) => {
    const conversationId = "non-reasoning-selection-validation";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Non-reasoning selection validation",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    session.model.reasoning = false;
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "非推理模型不得开启思考",
        submittedAt: 2,
        reasoning: "medium"
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "reasoning_level_invalid"
    );
    const valid = await fixture.submit({
      conversationId,
      text: "非推理模型保留关闭态",
      submittedAt: 3,
      reasoning: "none"
    });
    assert.deepEqual(session.thinkingLevelChanges, ["off"]);
    session.finishSuccessful("ok");
    await valid.result;
  });
}

async function assertVaultWritesUseExistingApproval(): Promise<void> {
  const authorizationCalls: string[] = [];
  const adapter = createPiVaultToolSecurityAdapter({
    authorization: {
      async authorize(input) {
        authorizationCalls.push(input.toolCallId);
        throw new PiVaultToolAuthorizationError("approval_denied");
      }
    },
    resultCorrection: {
      async correct() {
        throw new Error("unexpected_vault_result_correction");
      }
    }
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  await adapter.inlineExtension.factory({
    on(name: string, handler: unknown) {
      handlers.set(name, handler as (...args: unknown[]) => unknown);
    }
  } as never);
  const handleToolCall = handlers.get("tool_call");
  assert.ok(handleToolCall);
  const call = async (
    toolName: string,
    toolCallId: string,
    input: Readonly<Record<string, unknown>>
  ) => await handleToolCall({ toolName, toolCallId, input }, {
    signal: undefined
  });
  const reachedApproval = {
    block: true,
    reason: "approval_denied"
  } as const;

  assert.deepEqual(await call("note_create", "generic-create", {
    relativePath: "journal/2026-09-04.md",
    content: "agent-decided content"
  }), reachedApproval);
  assert.deepEqual(await call("note_update", "generic-update", {
    relativePath: "outputs/review.md",
    expectedVersion: `sha256:${"a".repeat(64)}`,
    content: "agent-decided content"
  }), reachedApproval);
  assert.deepEqual(
    authorizationCalls,
    ["generic-create", "generic-update"],
    "valid note writes enter the existing approval flow without workflow-specific intent parsing"
  );
}

async function assertUserQuestionUsesCentralFailClosedSecurity(): Promise<void> {
  const questionSecurity = new PiUserQuestionToolSecurity();
  const adapter = createPiVaultToolSecurityAdapter({
    authorization: {
      async authorize() {
        throw new Error("unexpected_vault_authorization");
      }
    },
    additionalToolSecurities: [questionSecurity],
    resultCorrection: {
      async correct() {
        throw new Error("unexpected_vault_result_correction");
      }
    }
  });
  const handlers = new Map<
    string,
    (...args: unknown[]) => unknown
  >();
  await adapter.inlineExtension.factory({
    on(name: string, handler: unknown) {
      handlers.set(name, handler as (...args: unknown[]) => unknown);
    }
  } as never);
  const handleToolCall = handlers.get("tool_call");
  const handleToolResult = handlers.get("tool_result");
  assert.ok(handleToolCall);
  assert.ok(handleToolResult);

  const argumentsValue = {
    questions: [{
      questionId: "question-1",
      prompt: "请选择继续方式",
      selection: "single",
      options: [
        { optionId: "continue", label: "继续" },
        { optionId: "stop", label: "停止" }
      ],
      allowSupplement: true
    }]
  } as const;
  const allowed = await handleToolCall({
    toolName: PI_USER_QUESTION_TOOL_ID,
    toolCallId: "user-question-valid",
    input: argumentsValue
  }, { signal: undefined });
  assert.equal(allowed, undefined, "valid structured Question is centrally authorized");

  const questions = questionSecurity.consume(
    "user-question-valid",
    structuredClone(argumentsValue)
  );
  assert.equal(questions[0]?.prompt, "请选择继续方式");
  questionSecurity.complete("user-question-valid", {
    interactionId: "question:fixture",
    outcome: "answered",
    questionCount: 1,
    text: "请选择继续方式\n回答：继续"
  });
  const corrected = await handleToolResult({
    toolName: PI_USER_QUESTION_TOOL_ID,
    toolCallId: "user-question-valid",
    content: [{ type: "text", text: "UNTRUSTED_TOOL_RESULT" }],
    details: { private: "UNTRUSTED_DETAILS" },
    isError: false
  }) as Readonly<{
    content: readonly Readonly<{ type: "text"; text: string }>[];
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>;
  assert.deepEqual(corrected.content, [{
    type: "text",
    text: "请选择继续方式\n回答：继续"
  }]);
  assert.deepEqual(corrected.details, {
    source: "echoink-turn-interaction",
    schemaVersion: 1,
    toolCallId: "user-question-valid",
    interactionId: "question:fixture",
    outcome: "answered",
    questionCount: 1
  });
  assert.equal(corrected.isError, false);
  assert.doesNotMatch(JSON.stringify(corrected), /UNTRUSTED/u);

  assert.deepEqual(await handleToolCall({
    toolName: PI_USER_QUESTION_TOOL_ID,
    toolCallId: "user-question-valid",
    input: argumentsValue
  }, { signal: undefined }), {
    block: true,
    reason: "authorization_failed"
  }, "a completed toolCallId cannot be replayed");

  assert.equal(await handleToolCall({
    toolName: PI_USER_QUESTION_TOOL_ID,
    toolCallId: "user-question-forged",
    input: argumentsValue
  }, { signal: undefined }), undefined);
  assert.throws(() => questionSecurity.consume("user-question-forged", {
    questions: [{
      ...argumentsValue.questions[0],
      prompt: "被替换的问题"
    }]
  }), /user_question_authorization_failed/u);
  assert.deepEqual(await handleToolResult({
    toolName: PI_USER_QUESTION_TOOL_ID,
    toolCallId: "user-question-forged",
    content: [],
    details: {},
    isError: false
  }), {
    content: [{ type: "text", text: "authorization_failed" }],
    details: {
      source: "echoink-turn-interaction",
      toolCallId: "user-question-forged",
      status: "failed"
    },
    isError: true
  }, "execute-time argument replacement fails closed");

  assert.deepEqual(await handleToolCall({
    toolName: "unregistered_product_tool",
    toolCallId: "unknown-tool",
    input: {}
  }, { signal: undefined }), {
    block: true,
    reason: "tool_policy_blocked"
  }, "unknown tools remain fail-closed");
}

function assertReasoningSummaryLifecycleSemantics(): void {
  const started = createReasoningSummary({
    conversationId: "conversation-reasoning",
    piSessionId: "session-reasoning",
    productRunId: "run-reasoning",
    startedAt: 10
  });
  const answered = completeReasoningAtFirstText({
    summary: started,
    observedAt: 20
  });
  const updatedAfterAnswer = updateReasoningActivity({
    summary: answered,
    activity: {
      id: "tool-call-1",
      kind: "tool",
      status: "completed",
      name: "task_update",
      startedAt: 18,
      updatedAt: 25
    }
  });
  assert.equal(updatedAfterAnswer.status, "completed");
  assert.equal(updatedAfterAnswer.firstAssistantTextAt, 20);
  assert.equal(updatedAfterAnswer.updatedAt, 25);
  assert.deepEqual(updatedAfterAnswer.activities.map((activity) => activity.id), [
    "tool-call-1"
  ]);

  const completedWithoutText = closeReasoningSummary({
    summary: createReasoningSummary({
      conversationId: "conversation-no-text",
      piSessionId: "session-no-text",
      productRunId: "run-no-text",
      startedAt: 30
    }),
    status: "completed",
    terminalAt: 45
  });
  assert.equal(completedWithoutText.status, "completed");
  assert.equal(completedWithoutText.firstAssistantTextAt, undefined);
  assert.equal(completedWithoutText.terminalAt, 45);
}

async function assertReasoningSummaryRuntimeLifecycle(): Promise<void> {
  await withFixture([
    "run-reasoning-task",
    "run-reasoning-no-text",
    "run-reasoning-failed",
    "run-reasoning-interrupted",
    "run-reasoning-cancelled"
  ], async (fixture) => {
    fixture.configureFactoryTools({
      registered: ["task_update"],
      defaults: ["task_update"],
      planAllowed: []
    });
    const conversationId = "reasoning-runtime-lifecycle";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Reasoning runtime lifecycle",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();

    const taskRun = await fixture.submit({
      conversationId,
      text: "执行结构化任务",
      submittedAt: 2
    });
    const taskEvents: PiChatRuntimeEvent[] = [];
    fixture.runtime.subscribeProductRun(taskRun.productRunId, (event) => {
      taskEvents.push(structuredClone(event));
    });
    session.beginProviderRequest();
    session.emitProviderReasoning("第一段公开推理");
    const plan = freezeEchoInkTaskPlan({
      schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
      planId: "reasoning-plan",
      title: "PRIVATE_TASK_TITLE_CANARY",
      status: "completed",
      version: 1,
      steps: [{
        stepId: "step-1",
        text: "PRIVATE_TASK_STEP_CANARY",
        status: "completed"
      }],
      source: "agent",
      productRunId: taskRun.productRunId,
      createdAt: 3,
      updatedAt: 4
    });
    session.finishTool("reasoning-task-update", "task_update", {
      details: { source: "echoink-task-plan", plan }
    }, false);
    session.emitProviderReasoning("工具后的第二段公开推理");
    session.emitAssistantText("首段公开回答");
    assert.equal(
      reasoningSummariesForRun(session.sessionManager, taskRun.productRunId).length,
      1,
      "streaming Provider, first text, Tool, and Task updates never append custom entries"
    );
    session.finishSuccessful("最终公开回答");
    await taskRun.result;
    const taskSummaries = reasoningSummariesForRun(
      session.sessionManager,
      taskRun.productRunId
    );
    assert.equal(taskSummaries.length, 2);
    assert.equal(taskSummaries[0]?.terminalAt, undefined);
    assert.equal(taskSummaries[1]?.status, "completed");
    assert.ok(taskSummaries[1]?.firstAssistantTextAt);
    assert.ok(taskSummaries[1]?.terminalAt);
    assert.deepEqual(
      new Set(taskSummaries[1]?.activities.map((activity) => activity.kind)),
      new Set(["provider", "tool", "task"])
    );
    assert.equal(
      taskSummaries[1]?.activities.find((activity) => activity.kind === "tool")?.id,
      stableHashedIdentity("reasoning-tool", "reasoning-task-update"),
      "runtime Tool activity and projected Tool message share one toolCallId identity"
    );
    assert.doesNotMatch(
      JSON.stringify(taskSummaries),
      /PRIVATE_TASK_(?:TITLE|STEP)_CANARY/u
    );
    const taskReasoningEvents = taskEvents.filter(
      (event): event is Extract<PiChatRuntimeEvent, { type: "reasoning_summary" }> =>
        event.type === "reasoning_summary"
    );
    assert.equal(taskReasoningEvents[0]?.summary.status, "running");
    assert.ok(taskReasoningEvents.some((event) =>
      event.summary.firstAssistantTextAt !== undefined
      && event.summary.activities.some((activity) => activity.kind === "task")
    ), "post-answer Task updates remain visible in the same live snapshot");
    const providerReasoningEvents = taskEvents.filter((event) =>
      event.type === "provider_reasoning_start"
      || event.type === "provider_reasoning_delta"
      || event.type === "provider_reasoning_end"
    );
    assert.deepEqual(
      providerReasoningEvents.map((event) => event.type),
      [
        "provider_reasoning_start",
        "provider_reasoning_delta",
        "provider_reasoning_end",
        "provider_reasoning_start",
        "provider_reasoning_delta",
        "provider_reasoning_end"
      ]
    );
    const providerReasoningIds = providerReasoningEvents
      .filter((event) => event.type === "provider_reasoning_start")
      .map((event) => event.reasoningId);
    assert.equal(new Set(providerReasoningIds).size, 2);
    assert.deepEqual(
      providerReasoningEvents
        .filter((event) => event.type === "provider_reasoning_end")
        .map((event) => event.text),
      ["第一段公开推理", "工具后的第二段公开推理"]
    );

    const noTextRun = await fixture.submit({
      conversationId,
      text: "合法无文本完成",
      submittedAt: 5
    });
    session.finishSuccessful("");
    await noTextRun.result;
    const noText = reasoningSummariesForRun(
      session.sessionManager,
      noTextRun.productRunId
    ).at(-1);
    assert.equal(noText?.status, "completed");
    assert.equal(noText?.firstAssistantTextAt, undefined);
    assert.ok(noText?.terminalAt);

    const failedRun = await fixture.submit({
      conversationId,
      text: "失败收口",
      submittedAt: 6
    });
    session.finishFailed("fixture failure");
    await failedRun.result;
    assert.equal(
      reasoningSummariesForRun(session.sessionManager, failedRun.productRunId).at(-1)?.status,
      "failed"
    );

    const interruptedRun = await fixture.submit({
      conversationId,
      text: "非 runtime abort 中断",
      submittedAt: 7
    });
    session.finishAborted();
    await interruptedRun.result;
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        interruptedRun.productRunId
      ).at(-1)?.status,
      "interrupted"
    );

    const cancelledRun = await fixture.submit({
      conversationId,
      text: "runtime abort 取消",
      submittedAt: 8
    });
    await fixture.runtime.abort(conversationId);
    await cancelledRun.result;
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        cancelledRun.productRunId
      ).at(-1)?.status,
      "cancelled"
    );
  });
}

function reasoningSummariesForRun(
  sessionManager: SessionManager,
  productRunId: string
): Readonly<EchoInkReasoningSummarySnapshot>[] {
  return sessionManager.getBranch().flatMap((entry) => {
    const summary = reasoningSummaryFromSessionEntry(
      entry,
      sessionManager.getSessionId()
    );
    return summary?.productRunId === productRunId ? [summary] : [];
  });
}

async function assertProviderReasoningUsesPerAssistantMessageClocks():
Promise<void> {
  let clock = 1_000;
  await withFixture(["provider-reasoning-clock-run"], async (fixture) => {
    const conversationId = "provider-reasoning-message-clocks";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Provider reasoning message clocks",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const run = await fixture.submit({
      conversationId,
      text: "验证逐 AssistantMessage 推理计时",
      submittedAt: 500
    });
    const session = fixture.latestSession();

    clock = 9_000;
    session.emitProviderReasoningBlocks(
      ["首个公开段", "同一消息的后续公开段"],
      1_000
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 18_000;
    session.emitToolStart("reasoning-clock-tool", "fixture_tool", {});
    session.emitToolEnd("reasoning-clock-tool", "fixture_tool", {}, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 26_000;
    session.emitProviderReasoningBlocks(
      ["Tool 后第二个 AssistantMessage 的首段"],
      20_000
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 30_000;
    session.finishSuccessful("计时完成");
    await run.result;

    const projection = await fixture.runtime.readProjection(conversationId);
    const segments = projection.messages
      .find((message) => message.assistantTurn?.turnId === run.productRunId)
      ?.assistantTurn?.providerReasoningSegments ?? [];
    assert.deepEqual(
      segments.map((segment) => ({
        text: segment.text,
        startedAt: segment.startedAt,
        durationMs: segment.durationMs
      })),
      [
        { text: "首个公开段", startedAt: 1_000, durationMs: 8_000 },
        { text: "同一消息的后续公开段", startedAt: 9_000, durationMs: 0 },
        {
          text: "Tool 后第二个 AssistantMessage 的首段",
          startedAt: 20_000,
          durationMs: 6_000
        }
      ]
    );
  }, { now: () => clock });
}

async function assertProjectionAndCatalogManagementStayAgentSessionFree():
Promise<void> {
  await withFixture([], async (fixture) => {
    for (const conversationId of ["history-a", "history-b", "history-managed"]) {
      await fixture.runtime.createConversation({
        conversationId,
        title: conversationId,
        cwd: fixture.root
      });
    }

    const projection = await fixture.runtime.readProjection("history-a");
    assert.equal(projection.catalog.conversationId, "history-a");
    assert.equal(fixture.sessions.length, 0, "readProjection must stay AgentSession-free");

    assert.equal((await fixture.runtime.listConversations()).length, 3);
    await fixture.runtime.setConversationStatus("history-managed", "archived");
    await fixture.runtime.setConversationStatus("history-managed", "deleted");
    assert.equal(
      fixture.sessions.length,
      0,
      "list, archive, and delete must stay AgentSession-free"
    );

    await fixture.runtime.activateConversation("history-a");
    assert.equal(fixture.sessions.length, 1, "opening must activate its AgentSession");
    await fixture.runtime.switchConversation("history-a", "history-b");
    assert.equal(fixture.sessions.length, 2, "switching must activate the target AgentSession");
  });
}

async function assertSwitchPreservesRunningConversationUntilSettlement():
Promise<void> {
  await withFixture(["run-background-switch"], async (fixture) => {
    for (const conversationId of ["background-a", "background-b", "background-c"]) {
      await fixture.runtime.createConversation({
        conversationId,
        title: conversationId,
        cwd: fixture.root
      });
    }

    await fixture.runtime.activateConversation("background-a");
    const run = await fixture.submit({
      conversationId: "background-a",
      text: "continue after switching",
      submittedAt: 10
    });
    const runningSession = fixture.latestSession();
    runningSession.emitAssistantText("partial before switch");
    await new Promise<void>((resolve) => setImmediate(resolve));

    await fixture.runtime.switchConversation("background-a", "background-b");
    await fixture.runtime.switchConversation("background-b", "background-c");
    assert.equal(runningSession.isStreaming, true);
    assert.equal(runningSession.disposed, false);
    assert.equal(runningSession.lifecycleCalls.includes("abort"), false);
    assert.equal(runningSession.lifecycleCalls.includes("dispose"), false);
    assert.equal(
      await fixture.runtime.releaseConversationIfIdle("background-a"),
      false,
      "a running conversation must not be released"
    );

    runningSession.finishSuccessful("completed after switch");
    assert.equal((await run.result).terminalState, "completed");
    const projection = await fixture.runtime.readProjection("background-a");
    assert.equal(
      projection.messages.some((message) =>
        message.role === "assistant"
        && message.text === "completed after switch"
      ),
      true,
      "the background answer must remain durable and readable"
    );
    assert.equal(
      await fixture.runtime.releaseConversationIfIdle("background-a"),
      true,
      "a settled inactive conversation may be released"
    );
    assert.equal(runningSession.disposed, true);
    assert.equal(runningSession.lifecycleCalls.includes("abort"), false);
  });
}

/** Real Pi 0.82.1 AgentSessions and their native faux transport; no network. */
export async function runPiNativeConcurrentSessionTests(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-pi-concurrent-")));
  const catalog = new FileConversationCatalog({
    storageRootPath: path.join(root, "pi-native"), vaultId: "offline-concurrent-vault"
  });
  const productRuns = new FileProductRunStore({
    storageRootPath: path.join(root, "pi-native"), vaultId: catalog.vaultId, catalog
  });
  const sessions = new Map<string, AgentSession>();
  const responses = new Map<string, ReturnType<typeof deferred>>();
  const starts = new Map<string, ReturnType<typeof deferred>>();
  const contexts = new Map<string, string>();
  const executionContexts = new Map<string, string>();
  let id = 0;
  const runtime = new PiNativeConversationRuntime({
    catalog, productRuns, sessionApi: API,
    resolveConversationCwd: () => root,
    idFactory: () => `concurrent-run-${++id}`,
    createAgentSession: async (input) => {
      const key = `${input.catalog.conversationId}:${input.modelId}`;
      const ready = deferred();
      const started = deferred();
      responses.set(key, ready);
      starts.set(key, started);
      const provider = fauxProvider({
        provider: input.runtimeProviderId,
        api: "openai-completions",
        models: [{ id: input.modelId!, reasoning: true,
          contextWindow: 32_000, maxTokens: 1_024 }]
      });
      provider.setResponses([async (context, options) => {
        contexts.set(key, JSON.stringify(context.messages));
        executionContexts.set(key, input.currentExecutionContext().conversationId);
        started.resolve();
        const aborted = deferred();
        const onAbort = () => aborted.resolve();
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        if (options?.signal?.aborted) aborted.resolve();
        try { await Promise.race([ready.promise, aborted.promise]); }
        finally { options?.signal?.removeEventListener("abort", onAbort); }
        return fauxAssistantMessage(`reply:${key}`);
      }]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
        modelsPath: null, allowModelNetwork: false
      });
      modelRuntime.registerNativeProvider(provider.provider);
      const model = provider.getModel();
      const { session } = await createAgentSession({
        cwd: root, agentDir: root, modelRuntime, model, noTools: "all",
        sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({
          defaultProvider: model.provider, defaultModel: model.id,
          defaultThinkingLevel: "off", compaction: { enabled: false },
          retry: { enabled: false }, packages: [], extensions: [],
          skills: [], prompts: [], themes: [], enableAnalytics: false
        }),
        resourceLoader: await createControlledVaultResourceLoader({
          vaultRoot: root, systemPrompt: "Offline concurrency acceptance."
        })
      });
      sessions.set(key, session);
      return { session };
    }
  });
  await runtime.initialize();
  try {
    for (const conversationId of ["a", "b"]) {
      await runtime.createConversation({ conversationId, title: conversationId, cwd: root });
    }
    const request = (conversationId: string, modelId: string, reasoning: "low" | "high") => ({
      conversationId, modelId, runtimeProviderId: `provider-${conversationId}`,
      text: `prompt:${conversationId}:${modelId}`, submittedAt: Date.now(), reasoning
    });
    const sendingA = runtime.submit(request("a", "model-a", "low"));
    await assert.rejects(runtime.submit(request("a", "model-a", "low")),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "conversation_busy",
      "same-conversation startup is reserved before the first async read");
    const [a, b] = await withTimeout(Promise.all([
      sendingA, runtime.submit(request("b", "model-b", "high"))
    ]), "two native AgentSession starts");
    await withTimeout(Promise.all([...starts.values()].map((start) => start.promise)), "both providers started");
    const sessionA = sessions.get("a:model-a")!;
    const sessionB = sessions.get("b:model-b")!;
    assert.notEqual(sessionA, sessionB);
    assert.notEqual(sessionA.agent, sessionB.agent);
    assert.equal(sessionA.isStreaming, true);
    assert.equal(sessionB.isStreaming, true, "B must stream before A completes");
    assert.equal(sessionA.thinkingLevel, "low");
    assert.equal(sessionB.thinkingLevel, "high");
    assert.deepEqual([...executionContexts.entries()].sort(), [
      ["a:model-a", "a"], ["b:model-b", "b"]
    ]);
    assert.match(contexts.get("a:model-a")!, /prompt:a:model-a/u);
    assert.doesNotMatch(contexts.get("a:model-a")!, /prompt:b/u);
    assert.match(contexts.get("b:model-b")!, /prompt:b:model-b/u);
    assert.doesNotMatch(contexts.get("b:model-b")!, /prompt:a/u);
    await assert.rejects(runtime.submit(request("b", "model-b", "high")),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "conversation_busy");
    const eventsB: PiChatRuntimeEvent[] = [];
    const subscription = runtime.subscribeProductRun(b.productRunId, (event) => eventsB.push(event));
    await withTimeout(runtime.abort("a"), "abort A independently");
    assert.equal((await a.result).terminalState, "cancelled");
    assert.equal(sessionB.isStreaming, true);
    const nextA = await runtime.submit(request("a", "model-a-next", "high"));
    const replacementA = sessions.get("a:model-a-next")!;
    assert.notEqual(replacementA, sessionA, "a new model only replaces A's idle session");
    assert.equal(replacementA.model?.id, "model-a-next");
    assert.equal(sessionB.isStreaming, true);
    responses.get("a:model-a-next")!.resolve();
    assert.equal((await nextA.result).terminalState, "completed");
    assert.equal(sessionB.isStreaming, true, "A's completion keeps B running");
    assert.equal(await runtime.releaseConversationIfIdle("a"), true);
    assert.equal(sessionB.isStreaming, true, "A's release keeps B running");
    responses.get("b:model-b")!.resolve();
    assert.equal((await b.result).terminalState, "completed");
    subscription.unsubscribe();
    assert.ok(eventsB.some((event) => event.type === "product_run_settled"));
    assert.ok(eventsB.every((event) => event.productRunId === b.productRunId
      && event.conversationId === "b" && event.piSessionId === b.piSessionId));
    const projectionA = await runtime.readProjection("a");
    const projectionB = await runtime.readProjection("b");
    assert.ok(projectionA.messages.some((message) => message.text === "reply:a:model-a-next"));
    assert.ok(projectionB.messages.some((message) => message.text === "reply:b:model-b"));
    assert.ok(projectionB.messages.every((message) => !message.text.includes("prompt:a")));
  } finally {
    for (const response of responses.values()) response.resolve();
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

async function assertConversationCreateRollsBackAfterCatalogReadbackFailure():
Promise<void> {
  await withFixture([], async (fixture) => {
    const existing = await fixture.runtime.createConversation({
      conversationId: "existing-before-create-rejection",
      title: "Existing conversation",
      cwd: fixture.root,
      createdAt: 1
    });
    const existingSessionBytes = await readFile(existing.sessionFile, "utf8");
    const layout = piNativeVaultFileLayout(
      fixture.catalog.storageRootPath,
      fixture.catalog.vaultId
    );
    const beforeSessions = (await readdir(layout.sessionRootPath)).sort();
    const beforeConversationClaims = (
      await readdir(layout.conversationBindingsRootPath)
    ).sort();
    const beforePiSessionClaims = (
      await readdir(layout.piSessionBindingsRootPath)
    ).sort();
    const originalUpsert = fixture.catalog.upsert.bind(fixture.catalog);
    let rejectedPiSessionId = "";
    let rejectedSessionFile = "";
    fixture.catalog.upsert = async (input) => {
      const persisted = await originalUpsert(input);
      if (input.conversationId === "catalog-readback-rejected-create") {
        rejectedPiSessionId = persisted.piSessionId;
        rejectedSessionFile = persisted.sessionFile;
        throw new PiNativeFileStoreError(
          "readback-diverged",
          "simulated Catalog readback rejection"
        );
      }
      return persisted;
    };

    try {
      await assert.rejects(
        fixture.runtime.createConversation({
          conversationId: "catalog-readback-rejected-create",
          title: "Rejected conversation",
          cwd: fixture.root,
          createdAt: 2
        }),
        (error: unknown) => error instanceof PiNativeFileStoreError
          && error.code === "readback-diverged"
      );
    } finally {
      fixture.catalog.upsert = originalUpsert;
    }

    assert.ok(rejectedPiSessionId, "the rejected create must reach Catalog persistence");
    assert.ok(rejectedSessionFile, "the rejected create must create a durable Session");
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await reopenedCatalog.initialize();
    assert.deepEqual(await reopenedCatalog.list(), [existing]);
    await assert.rejects(
      readFile(rejectedSessionFile, "utf8"),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    assert.deepEqual(
      (await readdir(layout.sessionRootPath)).sort(),
      beforeSessions,
      "a rejected Catalog readback must remove only its new Session JSONL"
    );
    assert.deepEqual(
      (await readdir(layout.conversationBindingsRootPath)).sort(),
      beforeConversationClaims,
      "a rejected create must remove its Conversation binding claim"
    );
    assert.deepEqual(
      (await readdir(layout.piSessionBindingsRootPath)).sort(),
      beforePiSessionClaims,
      "a rejected create must remove its Pi Session binding claim"
    );
    assert.equal(
      await readFile(existing.sessionFile, "utf8"),
      existingSessionBytes,
      "rollback must not rewrite an existing Conversation Session"
    );
    assert.deepEqual(await reopenedCatalog.get(existing.conversationId), existing);
    assert.equal(
      await reopenedCatalog.get("catalog-readback-rejected-create"),
      null
    );
  });
}

async function assertFailedAssistantHistoryIsDurableButExcludedFromMemory():
Promise<void> {
  await withFixture([
    "failed-history-run",
    "failed-history-follow-up-run"
  ], async (fixture) => {
    const conversationId = "failed-assistant-history-hygiene";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Failed Assistant history hygiene",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const firstSession = fixture.latestSession();
    const failedRun = await fixture.submit({
      conversationId,
      text: "触发中断前的用户问题",
      submittedAt: 2
    });
    firstSession.finishFailed(
      "provider_sse_json_invalid",
      "FAILED_ASSISTANT_PARTIAL_CANARY"
    );
    assert.equal((await failedRun.result).terminalState, "failed");
    assert.equal(
      (await fixture.productRuns.read(failedRun.productRunId))?.error,
      "provider_sse_json_invalid",
      "ProductRun must preserve the precise content-free Provider failure code"
    );
    assert.equal(fixture.runtime.releaseProductRun(failedRun.productRunId), true);

    const durableProjection = await fixture.runtime.readProjection(
      conversationId
    );
    const durableFailedAnswer = durableProjection.messages.find((message) =>
      message.role === "assistant"
      && message.text === "FAILED_ASSISTANT_PARTIAL_CANARY"
    );
    assert.equal(durableFailedAnswer?.status, "failed");
    assert.equal(
      durableFailedAnswer?.details,
      "Provider 返回的流数据格式损坏，回答未完成。"
    );

    await fixture.runtime.releaseConversation(conversationId);
    const reopenedProjection = await fixture.runtime.activateConversation(
      conversationId
    );
    const reopenedFailedAnswer = reopenedProjection.messages.find((message) =>
      message.role === "assistant"
      && message.text === "FAILED_ASSISTANT_PARTIAL_CANARY"
    );
    assert.equal(reopenedFailedAnswer?.status, "failed");
    assert.equal(reopenedFailedAnswer?.details, durableFailedAnswer?.details);

    const reopenedSession = fixture.latestSession();
    reopenedSession.sessionManager.appendMessage({
      ...assistantMessage("ABORTED_ASSISTANT_PARTIAL_CANARY", 400_001),
      stopReason: "aborted"
    });
    reopenedSession.sessionManager.appendMessage({
      ...assistantMessage("LENGTH_ASSISTANT_PARTIAL_CANARY", 400_002),
      stopReason: "length"
    });
    reopenedSession.sessionManager.appendMessage(
      assistantMessage("保留的完整 Assistant 历史", 400_003)
    );

    const followUp = await fixture.submit({
      conversationId,
      text: "检查下一轮 Memory 上下文",
      submittedAt: 3
    });
    const recentConversation = reopenedSession
      .memoryTurnsBeforeUserEntryAppend.at(-1)?.recentConversation ?? [];
    assert.match(recentConversation.join("\n"), /触发中断前的用户问题/u);
    assert.match(recentConversation.join("\n"), /保留的完整 Assistant 历史/u);
    assert.doesNotMatch(
      recentConversation.join("\n"),
      /FAILED_ASSISTANT|ABORTED_ASSISTANT|LENGTH_ASSISTANT/u,
      "Personal Memory recentConversation must exclude every failed partial"
    );
    reopenedSession.finishSuccessful("后续回答完成");
    assert.equal((await followUp.result).terminalState, "completed");
  });
}

function assertKnowledgeMaintenanceRequiresExplicitCommand(): void {
  assert.deepEqual(routeKnowledgeConversationCommand("/maintain raw/a.md"), {
    kind: "maintain",
    originalText: "/maintain raw/a.md",
    request: "raw/a.md"
  });
  for (const text of [
    "请帮我整理知识库",
    "维护一下 Raw 和 Wiki",
    "把这些内容沉淀成知识笔记"
  ]) {
    assert.deepEqual(routeKnowledgeConversationCommand(text), {
      kind: "chat",
      originalText: text
    });
  }
}

async function assertKnowledgeMaintenancePreferenceSnapshotIsTurnBound():
Promise<void> {
  let finalizeCalls = 0;
  let currentPreference: Readonly<{
    profileVersion: string;
    state: "default" | "custom";
    revision: string;
    providerResourceText: string;
  }> = Object.freeze({
    profileVersion: "echoink-knowledge-preference-profile-v1",
    state: "custom" as const,
    revision: `sha256:${"a".repeat(64)}`,
    providerResourceText: "PREFERENCE_SNAPSHOT_A"
  });
  const knowledge: PiKnowledgeRuntimePort = {
    async prepareMaintenancePreferences() {
      return currentPreference;
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async finalizeMaintenance() {
      finalizeCalls += 1;
    }
  };
  await withFixture(["run-knowledge-maintain-snapshot"], async (fixture) => {
    fixture.configureFactoryTools({
      registered: ["vault_search", "note_read", "knowledge_maintain"],
      defaults: ["vault_search", "note_read", "knowledge_maintain"],
      planAllowed: []
    });
    const conversationId = "knowledge-maintain-preference-snapshot";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Knowledge preference snapshot",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    const handle = await fixture.submit({
      conversationId,
      text: "/maintain raw/a.md",
      maintenanceScope: QUERY_MAINTENANCE_SCOPE,
      submittedAt: 3
    });

    currentPreference = Object.freeze({
      profileVersion: "echoink-knowledge-preference-profile-v1",
      state: "default" as const,
      revision: `sha256:${"b".repeat(64)}`,
      providerResourceText: "PREFERENCE_SNAPSHOT_B"
    });

    const turn = session.knowledgeTurnsBeforeUserEntryAppend.at(-1);
    assert.equal(turn?.kind, "maintain");
    const command = turn?.kind === "maintain"
      ? turn.command as unknown as Readonly<{
          mode: string;
          request: string;
          preference: typeof currentPreference;
        }>
      : null;
    if (!command || command.mode !== "maintain") {
      assert.fail("expected one direct maintenance turn snapshot");
    }
    assert.deepEqual(command.preference, {
      profileVersion: "echoink-knowledge-preference-profile-v1",
      state: "custom",
      revision: `sha256:${"a".repeat(64)}`,
      providerResourceText: "PREFERENCE_SNAPSHOT_A"
    });
    assert.deepEqual(
      fixture.currentKnowledgeTurn(),
      turn,
      "the active turn must retain its captured preference after settings change"
    );
    assert.deepEqual(
      new Set(session.activeToolSelections.at(-1)),
      new Set(["vault_search", "note_read", "knowledge_maintain"])
    );
    session.finishSuccessful("知识维护已完成。");
    assert.equal((await handle.result).terminalState, "failed");
    assert.equal(finalizeCalls, 0);
  }, { knowledge });
}

async function assertKnowledgeMaintenanceSettlementRequiresUniqueDurableResult():
Promise<void> {
  const finalizedProductRunIds: string[] = [];
  const knowledge: PiKnowledgeRuntimePort = {
    async prepareMaintenancePreferences() {
      return Object.freeze({
        profileVersion: "echoink-knowledge-preference-profile-v1",
        state: "default" as const,
        revision: `sha256:${"c".repeat(64)}`,
        providerResourceText: ""
      });
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    },
    async finalizeMaintenance(input) {
      finalizedProductRunIds.push(input.productRunId);
    }
  };
  const validEnvelope = createKnowledgeMaintenanceResultEnvelope({
    status: "completed",
    notes: [{
      operation: "created",
      path: "wiki/readback.md",
      title: "回读标题",
      summary: "来自知识维护最终回读的摘要"
    }],
    systemPaths: [".echoink/knowledge-maintenance/report.md"]
  });
  await withFixture(
    [
      "run-knowledge-maintain-valid-result",
      "run-knowledge-maintain-duplicate-result",
      "run-knowledge-maintain-missing-terminal-result",
      "run-knowledge-maintain-malformed-result",
      "run-knowledge-maintain-failed-result",
      "run-knowledge-maintain-mismatched-result",
      "run-knowledge-maintain-error-completed-result",
      "run-knowledge-maintain-error-noop-result"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["vault_search", "note_read", "knowledge_maintain"],
        defaults: [],
        planAllowed: []
      });
      const conversationId = "knowledge-maintain-settlement";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Knowledge maintenance settlement",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      let session = fixture.latestSession();

      const valid = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 3
      });
      session.finishTool(
        "maintain-valid",
        "knowledge_maintain",
        { details: { status: "completed", maintenanceResult: validEnvelope } },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await valid.result).terminalState, "completed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId]);

      const duplicate = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 4
      });
      for (const suffix of ["one", "two"]) {
        session.finishTool(
          `maintain-duplicate-${suffix}`,
          "knowledge_maintain",
          { details: { status: "completed", maintenanceResult: validEnvelope } },
          false
        );
      }
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await duplicate.result).terminalState, "completed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);
      await fixture.runtime.releaseConversation(conversationId);
      await fixture.runtime.activateConversation(conversationId);
      session = fixture.latestSession();

      const failedResult = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 7
      });
      session.finishTool(
        "maintain-failed",
        "knowledge_maintain",
        {
          details: {
            status: "failed",
            maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
              status: "failed",
              issues: [{
                code: "write_failed",
                message: "知识维护写入失败"
              }]
            })
          }
        },
        true
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await failedResult.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);

      const missingTerminal = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 5
      });
      session.startTool(
        "maintain-without-result",
        "knowledge_maintain",
        { request: "raw/a.md" }
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await missingTerminal.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);
      session = await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId
      );

      for (const [index, status] of (["completed", "noop"] as const).entries()) {
        const errorSuccess = await fixture.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 9 + index
        });
        session.finishTool(
          `maintain-error-${status}`,
          "knowledge_maintain",
          {
            details: {
              status: "completed",
              maintenanceResult: createKnowledgeMaintenanceResultEnvelope({
                status,
                ...(status === "completed"
                  ? {
                      notes: [{
                        operation: "created" as const,
                        path: "wiki/error-success.md",
                        title: "错误结果不得伪装成功",
                        summary: "isError=true 与成功信封冲突"
                      }]
                    }
                  : {})
              })
            }
          },
          true
        );
        session.finishSuccessful("知识维护已完成。");
        assert.equal((await errorSuccess.result).terminalState, "failed");
        assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);
        session = await assertInvalidMaintenanceResultSurvivesReopen(
          fixture,
          conversationId
        );
      }

      const malformed = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 6
      });
      session.finishTool(
        "maintain-malformed",
        "knowledge_maintain",
        {
          details: {
            status: "completed",
            maintenanceResult: { ...validEnvelope, schema: "forged.v1" }
          }
        },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await malformed.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);
      session = await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId
      );

      const mismatched = await fixture.submit({
        conversationId,
        text: "/maintain raw/a.md",
        maintenanceScope: QUERY_MAINTENANCE_SCOPE,
        submittedAt: 8
      });
      session.finishTool(
        "same-run-note-read",
        "note_read",
        { details: { status: "completed" } },
        false
      );
      session.startTool(
        "maintain-mismatched-call",
        "knowledge_maintain",
        { request: "raw/a.md" }
      );
      session.finishToolResult(
        "maintain-mismatched-result",
        "knowledge_maintain",
        { details: { status: "completed", maintenanceResult: validEnvelope } },
        false
      );
      session.finishSuccessful("知识维护已完成。");
      assert.equal((await mismatched.result).terminalState, "failed");
      assert.deepEqual(finalizedProductRunIds, [valid.productRunId, duplicate.productRunId]);
      await assertInvalidMaintenanceResultSurvivesReopen(
        fixture,
        conversationId,
        "same-run-note-read"
      );
    },
    { knowledge }
  );
}

async function assertInvalidMaintenanceResultSurvivesReopen(
  fixture: RuntimeFixture,
  conversationId: string,
  expectedOtherToolCallId?: string
): Promise<ControlledAgentSession> {
  const currentRunId = (await fixture.productRuns.list(conversationId)).at(-1)
    ?.productRunId;
  const assertProjection = async (label: string): Promise<void> => {
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.knowledgeBaseUi !== undefined
      ),
      false,
      label
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.text === "知识维护已完成。"
      ),
      true,
      `${label} must retain the Agent response without projecting a failure card`
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.text === "未取得唯一且可信的知识维护结果。"
      ),
      false,
      `${label} must not project the temporary invalid-result failure card`
    );
    assert.equal(
      projection.messages.some((message) =>
        message.runId === currentRunId
        && message.title === "知识维护失败"
      ),
      false,
      `${label} must not rewrite Agent messages as repeated failure cards`
    );
    if (expectedOtherToolCallId) {
      assert.equal(
        projection.messages.some((message) =>
          message.runId === currentRunId
          && message.id.endsWith(`:tool:${expectedOtherToolCallId}`)
          && message.status === "completed"
        ),
        true,
        `${label} must retain the other Tool result`
      );
    }
  };
  await assertProjection("live projection");
  await fixture.runtime.releaseConversation(conversationId);
  await assertProjection("reopened projection");
  await fixture.runtime.activateConversation(conversationId);
  await assertProjection("reactivated projection");
  return fixture.latestSession();
}

async function assertTrustedKnowledgeMaintenanceResultsSurviveSettlementAndReopen():
Promise<void> {
  const knowledge = maintenanceKnowledgeFixture();
  const cases = [
    { status: "partial", isError: true },
    { status: "failed", isError: true },
    { status: "write_uncertain", isError: true }
  ] as const;
  await withFixture(
    [
      ...cases.map(({ status }) => `run-maintain-trusted-${status}`),
      "run-maintain-completed-agent-failed",
      "run-maintain-noop-agent-failed"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["vault_search", "note_read", "knowledge_maintain"],
        defaults: [],
        planAllowed: []
      });

      for (const [index, testCase] of cases.entries()) {
        const conversationId = `maintain-trusted-${testCase.status}`;
        await createAndActivateMaintenanceConversation(
          fixture,
          conversationId
        );
        const handle = await fixture.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 10 + index
        });
        const envelope = createKnowledgeMaintenanceResultEnvelope({
          status: testCase.status,
          notes: [{
            operation: "created",
            path: `wiki/${testCase.status}.md`,
            title: `${testCase.status} 回读标题`,
            summary: `${testCase.status} 回读摘要`
          }],
          issues: [{
            code: `${testCase.status}_issue`,
            message: `${testCase.status} 真实问题`,
            path: `raw/${testCase.status}.md`
          }],
          systemPaths: [`.echoink/${testCase.status}-report.md`]
        });
        fixture.latestSession().finishTool(
          `maintain-trusted-${testCase.status}`,
          "knowledge_maintain",
          { details: { status: "failed", maintenanceResult: envelope } },
          testCase.isError
        );
        fixture.latestSession().finishSuccessful("维护结果见卡片。");
        assert.equal((await handle.result).terminalState, "failed");
        await assertMaintenanceCardSurvivesReopen({
          fixture,
          conversationId,
          productRunId: handle.productRunId,
          expectedTitle: testCase.status === "partial"
            ? "知识维护部分完成"
            : testCase.status === "write_uncertain"
              ? "知识写入状态不确定"
              : "知识维护失败",
          expectedStatus: "failed",
          expectedNotePath: `wiki/${testCase.status}.md`,
          expectedNoteDescription: `${testCase.status} 回读摘要`,
          expectedIssuePath: `raw/${testCase.status}.md`,
          expectedIssueDescription: `${testCase.status} 真实问题`
        });
      }

      for (const [index, status] of (["completed", "noop"] as const).entries()) {
        const conversationId = `maintain-${status}-agent-failed`;
        await createAndActivateMaintenanceConversation(
          fixture,
          conversationId
        );
        const handle = await fixture.submit({
          conversationId,
          text: "/maintain raw/a.md",
          maintenanceScope: QUERY_MAINTENANCE_SCOPE,
          submittedAt: 20 + index
        });
        const envelope = createKnowledgeMaintenanceResultEnvelope({
          status,
          ...(status === "completed"
            ? {
                notes: [{
                  operation: "created" as const,
                  path: "wiki/completed-before-agent-failure.md",
                  title: "已完成的知识动作",
                  summary: "Tool 已回读成功，后续 Agent 回答失败"
                }]
              }
            : {}),
          systemPaths: [`.echoink/${status}-report.md`]
        });
        fixture.latestSession().finishTool(
          `maintain-${status}-agent-failed`,
          "knowledge_maintain",
          { details: { status: "completed", maintenanceResult: envelope } },
          false
        );
        fixture.latestSession().finishFailed("后续 Agent 回答失败");
        const completed = await handle.result;
        assert.equal(completed.terminalState, "completed");
        assert.match(completed.maintenance?.warnings.join("\n") ?? "", /最后回复未完成/u);
        await assertMaintenanceCardSurvivesReopen({
          fixture,
          conversationId,
          productRunId: handle.productRunId,
          expectedTitle: status === "completed"
            ? "知识维护完成"
            : "没有需要提炼的知识",
          expectedStatus: "success",
          ...(status === "completed"
            ? { expectedNotePath: "wiki/completed-before-agent-failure.md" }
            : {})
        });
      }
    },
    { knowledge }
  );
}

function maintenanceKnowledgeFixture(): PiKnowledgeRuntimePort {
  return {
    async prepareMaintenancePreferences() {
      return Object.freeze({
        profileVersion: "echoink-knowledge-preference-profile-v1",
        state: "default" as const,
        revision: `sha256:${"d".repeat(64)}`,
        providerResourceText: ""
      });
    },
    async retrieveAsk() {
      throw new Error("not used by maintenance fixture");
    },
    async verifyAskReferences() {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([])
      });
    }
  };
}

async function createAndActivateMaintenanceConversation(
  fixture: RuntimeFixture,
  conversationId: string
): Promise<void> {
  await fixture.runtime.createConversation({
    conversationId,
    title: conversationId,
    cwd: fixture.root,
    createdAt: 2
  });
  await fixture.runtime.activateConversation(conversationId);
}

async function assertMaintenanceCardSurvivesReopen(input: Readonly<{
  fixture: RuntimeFixture;
  conversationId: string;
  productRunId: string;
  expectedTitle: string;
  expectedStatus: "success" | "failed";
  expectedNotePath?: string;
  expectedNoteDescription?: string;
  expectedIssuePath?: string;
  expectedIssueDescription?: string;
}>): Promise<void> {
  const assertProjection = async (label: string): Promise<void> => {
    const projection = await input.fixture.runtime.readProjection(
      input.conversationId
    );
    const card = projection.messages.find((message) =>
      message.runId === input.productRunId && message.knowledgeBaseUi
    )?.knowledgeBaseUi;
    assert.ok(card, `${label} must retain the trusted maintenance card`);
    assert.equal(card.title, input.expectedTitle, label);
    assert.equal(card.status, input.expectedStatus, label);
    if (input.expectedNotePath) {
      const note = card.sections.flatMap((section) => section.items).find(
        (item) => item.path === input.expectedNotePath
      );
      assert.ok(note, `${label} must retain the readback note path`);
      if (input.expectedNoteDescription) {
        assert.match(note.description ?? "", new RegExp(
          input.expectedNoteDescription
        ));
      }
    }
    if (input.expectedIssuePath) {
      const issue = card.sections.flatMap((section) => section.items).find(
        (item) => item.path === input.expectedIssuePath
      );
      assert.ok(issue, `${label} must retain the issue path`);
      if (input.expectedIssueDescription) {
        assert.equal(issue.description, input.expectedIssueDescription, label);
      }
    }
  };
  await assertProjection("live projection");
  await input.fixture.runtime.releaseConversation(input.conversationId);
  await assertProjection("reopened projection");
}

async function assertKnowledgeAskUsesAgentAndReadOnlyTools(): Promise<void> {
  const verified: PiKnowledgeReference[][] = [];
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "当前没有找到可引用的 Vault 依据；仍由 Agent 回答。",
        retrieval: Object.freeze({
          elapsedMs: 7,
          total: 0,
          returned: 0,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      verified.push([...input.references]);
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    }
  };
  await withFixture(
    ["run-knowledge-ask-normal", "run-knowledge-ask-no-memory"],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: [
          "knowledge_search",
          "knowledge_read",
          "vault_search",
          "note_read",
          "note_create",
          "knowledge_maintain",
          "memory_search",
          "memory_read",
          "memory_write",
          "external_web_read"
        ],
        defaults: [
          "knowledge_search", "knowledge_read", "external_web_read", "knowledge_maintain",
          "vault_search",
          "note_read",
          "note_create",
          "memory_search",
          "memory_read",
          "memory_write"
        ],
        planAllowed: ["vault_search", "note_read"],
        externalReadAllowed: ["external_web_read"]
      });
      fixture.setMemoryToolNames([
        "memory_search",
        "memory_read",
        "memory_write"
      ]);
      const conversationId = "knowledge-ask-agent";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Knowledge ask agent",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();

      const normal = await fixture.submit({
        conversationId,
        text: "/ask 空库也请解释这个概念",
        memoryMode: "normal",
        permission: "read-only",
        submittedAt: 3
      });
      assert.equal(session.promptTexts.at(-1), "/ask 空库也请解释这个概念");
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set([
          "knowledge_search",
          "knowledge_read",
          "vault_search", "external_web_read",
          "note_read",
          "memory_search",
          "memory_read"
        ])
      );
      for (const forbidden of [
        "memory_write",
        "note_create",
        "knowledge_maintain"
      ]) {
        assert.equal(session.activeToolSelections.at(-1)?.includes(forbidden), false);
      }
      session.finishSuccessful("当前没有 Vault 依据；这是模型分析。");
      assert.equal((await normal.result).terminalState, "completed");

      const noMemory = await fixture.submit({
        conversationId,
        text: "/ask 不使用 Memory 回答",
        memoryMode: "no_memory",
        permission: "read-only",
        submittedAt: 4
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set(["knowledge_search", "knowledge_read", "note_read", "vault_search", "external_web_read"])
      );
      assert.equal(
        session.activeToolSelections.at(-1)?.some((name) =>
          name.startsWith("memory_")
        ),
        false
      );
      session.finishSuccessful("no_memory 模式回答。");
      assert.equal((await noMemory.result).terminalState, "completed");
      assert.deepEqual(verified, [[], []]);
    },
    { knowledge }
  );
}

async function assertAskSourceAttributionCapturesOnlyInjectedPrimaryMemory(): Promise<void> {
  const reference: PiKnowledgeReference = Object.freeze({
    referenceId: "vault-reference-a",
    vaultRelativePath: "wiki/attribution.md",
    title: "Vault attribution",
    excerpt: "实际注入的 Vault 参考",
    contentRevision: `sha256:${"a".repeat(64)}`,
    lineStart: 1,
    lineEnd: 1
  });
  const usage: Array<Parameters<NonNullable<
    PiKnowledgeRuntimePort["recordUsage"]
  >>[0]> = [];
  let askCount = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      const references = askCount++ === 0 ? [reference] : [];
      return Object.freeze({
        status: references.length ? "ready" as const : "no_evidence" as const,
        references: Object.freeze(references),
        providerResourceText: "attribution fixture",
        retrieval: Object.freeze({
          elapsedMs: 1,
          total: 1,
          returned: 1,
          remaining: 0,
          hasMore: false,
          exhausted: true
        })
      });
    },
    async verifyAskReferences(input) {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    },
    async recordUsage(input) {
      usage.push(structuredClone(input));
    }
  };
  await withFixture(
    ["run-ask-source-attribution", "run-ask-source-attribution-empty"],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: ["knowledge_search", "knowledge_read", "note_read"],
        defaults: ["knowledge_search", "knowledge_read", "note_read"],
        planAllowed: []
      });
      const conversationId = "ask-source-attribution";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Ask source attribution",
        cwd: fixture.root,
        createdAt: 1
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();
      const first = await fixture.submit({
        conversationId,
        text: "/ask 请用已注入来源回答",
        submittedAt: 2
      });
      const sources = [
        { id: "memory-primary-a", title: "一级 Memory A" },
        { id: "memory-primary-a", title: "重复 Memory 不应再次展示" },
        { id: "memory-primary-b", title: "一级 Memory B" }
      ];
      await fixture.reportAskPersonalMemorySources({
        productRunId: first.productRunId,
        sources
      });
      sources[0]!.title = "外部突变不能进入 usage";
      session.finishSuccessful("已完成来源归属回答。");
      await first.result;

      assert.equal(usage.length, 1);
      assert.deepEqual(usage[0]?.event, {
        sourceEventId: usage[0]?.event.sourceEventId,
        vaultId: usage[0]?.event.vaultId,
        conversationId,
        piSessionId: usage[0]?.event.piSessionId,
        piEntryId: usage[0]?.event.piEntryId,
        productRunId: first.productRunId,
        referenceIds: [reference.referenceId],
        workflow: "ask",
        producedPaths: [],
        personalMemorySources: [
          { id: "memory-primary-a", title: "一级 Memory A" },
          { id: "memory-primary-b", title: "一级 Memory B" }
        ]
      });

      const empty = await fixture.submit({
        conversationId,
        text: "/ask 本轮没有可展示来源",
        submittedAt: 3
      });
      session.finishSuccessful("没有来源的回答。");
      await empty.result;
      assert.deepEqual(usage[1]?.event.personalMemorySources, []);
      assert.deepEqual(usage[1]?.event.referenceIds, []);
    },
    { knowledge }
  );
}

async function assertKnowledgeObservationAndProgressArePrivacySafe(): Promise<void> {
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() {
      return Object.freeze({
        status: "no_evidence" as const,
        references: Object.freeze([]),
        providerResourceText: "PRIVATE_RESOURCE_CANARY",
        retrieval: Object.freeze({
          elapsedMs: 11,
          total: 120,
          returned: 8,
          remaining: 112,
          hasMore: true,
          exhausted: false
        })
      });
    },
    async verifyAskReferences(input) {
      return Object.freeze({
        status: "valid" as const,
        references: Object.freeze([...input.references])
      });
    }
  };
  await withFixture(["run-knowledge-observation"], async (fixture) => {
    fixture.configureFactoryTools({
      registered: [
        "knowledge_search",
        "knowledge_read",
        "note_read",
        "memory_search",
        "memory_read"
      ],
      defaults: ["memory_search", "memory_read"],
      planAllowed: []
    });
    fixture.setMemoryToolNames(["memory_search", "memory_read"]);
    const conversationId = "knowledge-observation-private";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Knowledge observation",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    const handle = await fixture.submit({
      conversationId,
      text: "/ask PRIVATE_QUERY_CANARY",
      submittedAt: 3
    });
    const events: PiChatRuntimeEvent[] = [];
    fixture.runtime.subscribeProductRun(handle.productRunId, (event) => {
      events.push(structuredClone(event));
    });
    await fixture.reportMemoryRecall({
      status: "active",
      stage: "loading",
      elapsedMs: 0
    });
    await fixture.reportMemoryRecall({
      status: "completed",
      stage: "assembling",
      elapsedMs: 7,
      recall: {
        result: "completed",
        stage: "assembling",
        elapsedMs: 7,
        scanned: 12,
        candidates: 4,
        injected: 2,
        remaining: 2,
        exhausted: false
      }
    });

    session.emitToolStart(
      "knowledge-search-continuation",
      "knowledge_search",
      { query: "PRIVATE_QUERY_CANARY", cursor: "PRIVATE_CURSOR_CANARY" }
    );
    session.emitToolEnd(
      "knowledge-search-continuation",
      "knowledge_search",
      {
        content: [{ type: "text", text: "PRIVATE_SEARCH_RESULT_CANARY" }],
        details: {
          source: "echoink-knowledge",
          status: "completed",
          elapsedMs: 5,
          total: 120,
          returned: 10,
          remaining: 102,
          hasMore: true,
          exhausted: false,
          continuation: true
        }
      },
      false
    );
    session.emitToolStart(
      "knowledge-read-one",
      "knowledge_read",
      {
        vaultRelativePath: "wiki/PRIVATE_PATH_CANARY.md",
        expectedContentRevision: `sha256:${"b".repeat(64)}`
      }
    );
    session.emitToolEnd(
      "knowledge-read-one",
      "knowledge_read",
      {
        content: [{ type: "text", text: "PRIVATE_NOTE_CANARY" }],
        details: { source: "echoink-knowledge", status: "completed" }
      },
      false
    );
    session.emitToolStart(
      "memory-search-one",
      "memory_search",
      { query: "PRIVATE_MEMORY_QUERY_CANARY" }
    );
    session.emitToolEnd(
      "memory-search-one",
      "memory_search",
      {
        content: [{ type: "text", text: "PRIVATE_MEMORY_RESULT_CANARY" }],
        details: { source: "echoink-personal-memory", status: "completed" }
      },
      false
    );
    session.beginProviderRequest();
    session.emitAssistantText("首个非空回答");
    session.finishSuccessful("当前没有 Vault 依据；这是模型分析。");
    const settled = await handle.result;
    assert.equal(settled.terminalState, "completed");
    assert.ok(settled.knowledge?.modelFirstTextLatencyMs);
    assert.deepEqual({
      ...settled.knowledge,
      modelFirstTextLatencyMs: undefined
    }, {
      workflow: "ask",
      localRetrievalElapsedMs: 16,
      candidates: 120,
      returned: 18,
      remaining: 102,
      hasMore: true,
      exhausted: false,
      continuationCount: 1,
      knowledgeReadCount: 1,
      memoryRecallUsed: true,
      memorySearchUsed: true,
      memoryReadUsed: false,
      conflictOrFreshnessTriggered: false,
      modelFirstTextLatencyMs: undefined
    });
    const serializedEvents = JSON.stringify(events);
    assert.doesNotMatch(
      serializedEvents,
      /PRIVATE_(?:QUERY|CURSOR|SEARCH_RESULT|PATH|NOTE|MEMORY_QUERY|MEMORY_RESULT)_CANARY/u
    );
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "continuing_search"
      && event.status === "active"
    ));
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "reading_knowledge"
      && event.status === "active"
    ));
    assert.ok(events.some((event) =>
      event.type === "knowledge_progress"
      && event.stage === "comparing_memory"
      && event.status === "active"
    ));
    const terminalReasoning = events.filter(
      (event): event is Extract<PiChatRuntimeEvent, { type: "reasoning_summary" }> =>
        event.type === "reasoning_summary"
    ).at(-1)?.summary;
    assert.ok(terminalReasoning);
    assert.deepEqual(
      new Set(terminalReasoning!.activities.map((activity) => activity.kind)),
      new Set(["knowledge", "memory", "tool", "provider"])
    );
    assert.equal(
      terminalReasoning!.activities.find((activity) =>
        activity.kind === "memory" && activity.stage === "assembling"
      )?.total,
      4
    );
    assert.doesNotMatch(JSON.stringify(settled.knowledge), /sha256|PRIVATE_/u);
  }, { knowledge });
}

async function assertMemoryTurnIsAvailableBeforeUserEntryPersistence(): Promise<void> {
  await withFixture(["run-memory-preappend-normal", "run-memory-preappend-no-memory"], async (fixture) => {
    const conversationId = "memory-preappend-timing";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Memory preappend timing",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    for (const memoryMode of ["normal", "no_memory"] as const) {
      const text = `preappend-${memoryMode}`;
      const handle = await fixture.submit({
        conversationId,
        text,
        memoryMode,
        submittedAt: 3
      });
      const turn = fixture.latestSession().memoryTurnsBeforeUserEntryAppend.at(-1);
      assert.ok(turn, `${memoryMode} submit 必须在 user Entry 落盘前提供 Recall 身份`);
      assert.equal(turn.query, text);
      assert.equal(turn.memoryMode, memoryMode);
      assert.equal(turn.productRunId, handle.productRunId);
      assert.equal(turn.userEntryId, undefined);
      const recall = {
        result: memoryMode === "normal" ? "completed" as const : "skipped_no_memory" as const,
        stage: "assembling" as const,
        elapsedMs: 12,
        scanned: memoryMode === "normal" ? 10 : 0,
        candidates: memoryMode === "normal" ? 3 : 0,
        injected: memoryMode === "normal" ? 2 : 0,
        remaining: memoryMode === "normal" ? 8 : 0,
        exhausted: memoryMode === "no_memory"
      };
      await fixture.reportMemoryRecall({
        status: "completed",
        stage: "assembling",
        elapsedMs: 12,
        recall
      });
      assert.deepEqual((await fixture.productRuns.read(handle.productRunId))?.memoryRecall, recall);
      fixture.latestSession().finishSuccessful("timing checked");
      await handle.result;
    }
  });
}

async function assertConversationDerivationCreatesIndependentDurablePrefixes():
Promise<void> {
  await withFixture(["run-prefix-first", "run-prefix-future"], async (fixture) => {
    const sourceConversationId = "derive-source-conversation";
    const sourceCatalog = await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "源会话",
      cwd: fixture.root,
      defaultSkillId: "knowledge-review",
      createdAt: 2
    });
    assert.equal(sourceCatalog.defaultSkillId, "knowledge-review");
    await fixture.runtime.activateConversation(sourceConversationId);

    const first = await fixture.submit({
      conversationId: sourceConversationId,
      text: "第一条提问",
      submittedAt: 3
    });
    fixture.latestSession().finishSuccessful("第一条回复");
    const firstSettled = await first.result;
    assert.ok(firstSettled.assistantEntryId);

    const future = await fixture.submit({
      conversationId: sourceConversationId,
      text: "需要重新编辑的第二条提问",
      submittedAt: 4
    });
    fixture.latestSession().finishSuccessful("锚点之后不得继承的未来回复");
    await future.result;

    const sourceBefore = await fixture.runtime.readProjection(sourceConversationId);
    const sourceMessageIdsBefore = sourceBefore.messages.map((message) => message.id);
    const sourceSessionFileBefore = sourceCatalog.sessionFile;

    const fromUser = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-from-user",
      anchorEntryId: future.userEntryId,
      title: "重新编辑第二条提问",
      createdAt: 5
    });
    assert.equal(fromUser.anchorRole, "user");
    assert.equal(fromUser.editorText, "需要重新编辑的第二条提问");
    assert.equal(fromUser.projection.catalog.defaultSkillId, "knowledge-review");
    assert.notEqual(fromUser.projection.catalog.piSessionId, sourceCatalog.piSessionId);
    assert.notEqual(fromUser.projection.catalog.sessionFile, sourceSessionFileBefore);
    assert.deepEqual(
      visibleConversationText(fromUser.projection),
      ["user:第一条提问", "assistant:第一条回复"],
      "a user anchor inherits only the durable prefix before that user Entry"
    );

    const fromAssistant = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-from-assistant",
      anchorEntryId: firstSettled.assistantEntryId,
      title: "从第一条回复继续",
      createdAt: 6
    });
    assert.equal(fromAssistant.anchorRole, "assistant");
    assert.equal(fromAssistant.editorText, "");
    assert.equal(fromAssistant.projection.catalog.defaultSkillId, "knowledge-review");
    assert.deepEqual(
      visibleConversationText(fromAssistant.projection),
      ["user:第一条提问", "assistant:第一条回复"],
      "an assistant anchor includes that reply but excludes every later Entry"
    );

    const sourceAfter = await fixture.runtime.readProjection(sourceConversationId);
    assert.deepEqual(sourceAfter.messages.map((message) => message.id), sourceMessageIdsBefore);
    assert.equal(sourceAfter.activeLeafId, sourceBefore.activeLeafId);
    assert.equal(sourceAfter.catalog.sessionFile, sourceSessionFileBefore);
    assert.equal(sourceAfter.catalog.piSessionId, sourceCatalog.piSessionId);
    assert.equal((await fixture.runtime.listConversations(["active"])).length, 3);

    await fixture.runtime.shutdown();
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId
    });
    const reopenedRuns = new FileProductRunStore({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId,
      catalog: reopenedCatalog
    });
    const reopened = new PiNativeConversationRuntime({
      catalog: reopenedCatalog,
      productRuns: reopenedRuns,
      sessionApi: API,
      resolveConversationCwd: () => fixture.root,
      createAgentSession: async (input) => ({
        session: new ControlledAgentSession(input.sessionManager).asAgentSession(),
        planToolNames: []
      })
    });
    await reopened.initialize();
    try {
      assert.equal((await reopened.listConversations(["active"])).length, 3);
      const reopenedFromUser = await reopened.activateConversation("derive-from-user");
      assert.equal(reopenedFromUser.catalog.defaultSkillId, "knowledge-review");
      assert.deepEqual(
        visibleConversationText(reopenedFromUser),
        ["user:第一条提问", "assistant:第一条回复"],
        "the user-anchor Conversation must survive a full runtime restart"
      );
      const reopenedFromAssistant = await reopened.activateConversation(
        "derive-from-assistant"
      );
      assert.equal(reopenedFromAssistant.catalog.defaultSkillId, "knowledge-review");
      assert.deepEqual(
        visibleConversationText(reopenedFromAssistant),
        ["user:第一条提问", "assistant:第一条回复"],
        "a fresh runtime must restore the independently cataloged Pi Session prefix"
      );
    } finally {
      await reopened.shutdown();
    }
  }, {
    skills: {
      selectForTask: async () => null,
      resolveById: async ({ id }) => {
        assert.equal(id, "knowledge-review");
        const selected = Object.freeze({
          id,
          skillPath: "/fixture/skills/knowledge-review/SKILL.md",
          skillName: id
        });
        return Object.freeze({
          ...selected,
          revision: "a".repeat(64),
          skills: Object.freeze([selected]),
          applicableSkillIds: Object.freeze([id]),
          requiresFreshnessVerification: false
        });
      },
      recordUse: async () => undefined,
      reviewCompletedTask: async () => undefined
    }
  });
}

async function assertDerivedActivationFailureRemainsAVisibleDurableConversation():
Promise<void> {
  await withFixture(["run-derived-activation-source"], async (fixture) => {
    const sourceConversationId = "derive-activation-failure-source";
    await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "激活失败来源",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(sourceConversationId);
    const sourceRun = await fixture.submit({
      conversationId: sourceConversationId,
      text: "需要保留的来源提问",
      submittedAt: 3
    });
    fixture.latestSession().finishSuccessful("需要保留的来源回复");
    const settled = await sourceRun.result;
    assert.ok(settled.assistantEntryId);

    fixture.failNextActivation(new Error("injected-derived-activation-failure"));
    const derived = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-activation-failure-target",
      anchorEntryId: settled.assistantEntryId,
      title: "已创建但暂未激活",
      createdAt: 4
    });

    assert.deepEqual((derived as any).activation, {
      status: "failed",
      message: "injected-derived-activation-failure"
    });
    assert.equal(
      derived.projection.catalog.conversationId,
      "derive-activation-failure-target"
    );
    assert.deepEqual(
      visibleConversationText(derived.projection),
      ["user:需要保留的来源提问", "assistant:需要保留的来源回复"]
    );
    assert.equal((await fixture.runtime.listConversations(["active"])).length, 2);
    assert.ok(
      await readFile(derived.projection.catalog.sessionFile!, "utf8"),
      "the cataloged JSONL must exist after activation failure"
    );

    await fixture.runtime.shutdown();
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId
    });
    const reopenedRuns = new FileProductRunStore({
      storageRootPath: path.join(fixture.root, "pi-native"),
      vaultId: fixture.catalog.vaultId,
      catalog: reopenedCatalog
    });
    const reopened = new PiNativeConversationRuntime({
      catalog: reopenedCatalog,
      productRuns: reopenedRuns,
      sessionApi: API,
      resolveConversationCwd: () => fixture.root,
      createAgentSession: async (input) => ({
        session: new ControlledAgentSession(
          input.sessionManager,
          [],
          [],
          input.currentTaskPlanTurnContext
        ).asAgentSession(),
        planToolNames: []
      })
    });
    await reopened.initialize();
    try {
      assert.equal((await reopened.listConversations(["active"])).length, 2);
      assert.deepEqual(
        visibleConversationText(
          await reopened.activateConversation(
            "derive-activation-failure-target"
          )
        ),
        ["user:需要保留的来源提问", "assistant:需要保留的来源回复"]
      );
    } finally {
      await reopened.shutdown();
    }
  });
}

async function assertDerivationExcludesIdentityBoundOperationalState():
Promise<void> {
  await withFixture(["run-derived-clean-context"], async (fixture) => {
    const sourceConversationId = "derive-operational-state-source";
    const sourceCatalog = await fixture.runtime.createConversation({
      conversationId: sourceConversationId,
      title: "带运行状态的来源",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(sourceConversationId);
    const sourceAgent = fixture.latestSession();
    sourceAgent.sessionManager.appendMessage({
      role: "user",
      content: "继承的第一条提问",
      timestamp: 10
    });
    sourceAgent.sessionManager.appendMessage(assistantMessage(
      "继承的第一条回复",
      11
    ));
    appendTaskPlanEntry(
      sourceAgent.sessionManager,
      sourceCatalog,
      freezeEchoInkTaskPlan({
        schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
        planId: "source-only-plan",
        title: "不得注入派生会话的来源计划",
        status: "in_progress",
        version: 1,
        steps: [{
          stepId: "source-step",
          text: "来源会话中的未完成步骤",
          status: "in_progress"
        }],
        currentStepId: "source-step",
        source: "agent",
        productRunId: "source-product-run",
        createdAt: 12,
        updatedAt: 12
      })
    );
    const contextEntries = sourceAgent.sessionManager.buildContextEntries();
    sourceAgent.sessionManager.appendCustomEntry(
      PI_CONTEXT_LEDGER_CUSTOM_TYPE,
      buildPiContextLedger({
        conversationId: sourceConversationId,
        piSessionId: sourceCatalog.piSessionId,
        productRunId: "source-ledger-run",
        requestSequence: 1,
        requestLeafId: sourceAgent.sessionManager.getLeafId(),
        recordedAt: 13,
        model: { provider: "fixture-provider", id: "fixture-model" },
        budget: calculatePiEffectiveInputBudget({
          contextWindow: 32_768,
          maxOutputReserve: 4_096
        }),
        context: {
          systemPrompt: "source ledger",
          messages: [],
          tools: []
        },
        contextEntries,
        vaultToolNames: new Set(),
        mcpToolNames: new Set()
      })
    );
    sourceAgent.sessionManager.appendMessage({
      role: "user",
      content: "运行状态之后仍应继承的提问",
      timestamp: 14
    });
    const anchorEntryId = sourceAgent.sessionManager.appendMessage(
      assistantMessage("运行状态之后仍应继承的回复", 15)
    );

    const derived = await fixture.runtime.deriveConversation({
      sourceConversationId,
      targetConversationId: "derive-operational-state-target",
      anchorEntryId,
      title: "干净的派生上下文",
      createdAt: 16
    });
    assert.deepEqual((derived as any).activation, { status: "activated" });
    assert.equal(
      derived.projection.messages.some((message) =>
        message.itemType === "taskPlan" || Boolean(message.taskPlan)
      ),
      false,
      "the derived UI must not expose source Task Plan state"
    );
    assert.equal(
      derived.projection.contextLedger,
      undefined,
      "the derived projection must not return the source Context Ledger"
    );
    const derivedAgent = fixture.latestSession();
    assert.equal(
      derivedAgent.sessionManager.getBranch().some((entry) =>
        entry.type === "custom"
        && (
          entry.customType === "echoink.task-plan.v1"
          || entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
        )
      ),
      false,
      "identity-bound operational entries must be absent from the durable prefix"
    );
    assert.equal(
      sourceAgent.sessionManager.getBranch().filter((entry) =>
        entry.type === "custom"
        && (
          entry.customType === "echoink.task-plan.v1"
          || entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
        )
      ).length,
      2,
      "the source Conversation must retain its Task Plan and Context Ledger"
    );

    await fixture.runtime.releaseConversation(
      derived.projection.catalog.conversationId
    );
    const reopenedProjection = await fixture.runtime.activateConversation(
      derived.projection.catalog.conversationId
    );
    assert.deepEqual(
      visibleConversationText(reopenedProjection),
      [
        "user:继承的第一条提问",
        "assistant:继承的第一条回复",
        "user:运行状态之后仍应继承的提问",
        "assistant:运行状态之后仍应继承的回复"
      ],
      "filtering operational Entries must preserve the remaining history after reopen"
    );
    assert.equal(reopenedProjection.contextLedger, undefined);
    const reopenedDerivedAgent = fixture.latestSession();

    const continued = await fixture.submit({
      conversationId: derived.projection.catalog.conversationId,
      text: "验证派生会话的 Provider Context",
      submittedAt: 17
    });
    assert.deepEqual(reopenedDerivedAgent.taskPlanTurns.at(-1), {
      mode: "agent",
      plan: null
    });
    reopenedDerivedAgent.finishSuccessful("派生会话继续成功");
    await continued.result;
  });
}

function visibleConversationText(
  projection: Awaited<ReturnType<PiNativeConversationRuntime["readProjection"]>>
): string[] {
  return projection.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}:${message.text}`);
}

export async function runPiNativeMemoryProjectIdentityTests(): Promise<void> {
  await assertNormalMemoryTurnResolvesExplicitProjectIdentity();
}

export async function runPiNativeTaskPlanRuntimeTests(): Promise<void> {
  await withFixture(
    [
      "run-task-plan-missing-update",
      "run-task-plan-mode",
      "run-task-plan-execution",
      "run-task-plan-auto-pause"
    ],
    async (fixture) => {
      fixture.configureFactoryTools({
        registered: [
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ],
        defaults: [
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ],
        planAllowed: ["vault_search", "note_read", "task_update"]
      });
      const conversationId = "task-plan-runtime";
      const catalog = await fixture.runtime.createConversation({
        conversationId,
        title: "Task plan runtime",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();
      const pending = freezeEchoInkTaskPlan({
        schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
        planId: "plan-runtime",
        title: "验证同一 Pi Session 的计划",
        status: "pending",
        version: 1,
        steps: [
          { stepId: "step-read", text: "只读规划", status: "pending" },
          { stepId: "step-write", text: "获准后执行", status: "pending" }
        ],
        source: "agent",
        createdAt: 3,
        updatedAt: 3
      });
      appendTaskPlanEntry(session.sessionManager, catalog, pending);

      const missingUpdate = await fixture.submit({
        conversationId,
        text: "故意遗漏结构化计划更新",
        mode: "plan",
        submittedAt: 4
      });
      session.finishSuccessful("只有文本计划");
      await assert.rejects(
        missingUpdate.result,
        (error: unknown) => error instanceof PiNativeConversationRuntimeError
          && error.code === "projection_unsettled"
          && /task_update/u.test(error.message)
      );
      assert.equal(
        fixture.runtime.releaseProductRun(missingUpdate.productRunId),
        true
      );

      const planned = await fixture.submit({
        conversationId,
        text: "修改当前计划",
        mode: "plan",
        submittedAt: 5
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set(["vault_search", "note_read", "task_update"])
      );
      assert.equal(
        session.activeToolSelections.at(-1)?.includes("note_create"),
        false,
        "Plan mode must not activate a registered write Tool"
      );
      appendTaskPlanEntry(
        session.sessionManager,
        catalog,
        freezeEchoInkTaskPlan({
          ...pending,
          version: 2,
          productRunId: planned.productRunId,
          updatedAt: 5
        })
      );
      session.finishSuccessful("计划已修改");
      await planned.result;
      fixture.runtime.releaseProductRun(planned.productRunId);

      const executed = await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "execute"
      });
      assert.equal(executed.plan.status, "in_progress");
      assert.equal(executed.plan.currentStepId, "step-read");
      assert.equal(session.sessionManager.getSessionId(), catalog.piSessionId);

      const run = await fixture.submit({
        conversationId,
        text: "执行当前计划",
        mode: "agent",
        submittedAt: 6
      });
      assert.deepEqual(
        new Set(session.activeToolSelections.at(-1)),
        new Set([
          "vault_search",
          "note_read",
          "note_create",
          "task_update"
        ])
      );
      await fixture.runtime.steer(conversationId, "先完成只读核对");
      await fixture.runtime.followUp(conversationId, "计划结束后总结结果");
      assert.deepEqual(session.steering, ["先完成只读核对"]);
      assert.deepEqual(session.followUps, ["计划结束后总结结果"]);
      await fixture.runtime.abort(conversationId);
      assert.equal((await run.result).terminalState, "cancelled");
      const paused = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.steps[0]?.status, "paused");
      assert.equal(paused?.steps[1]?.status, "pending");
      assert.equal(fixture.runtime.releaseProductRun(run.productRunId), true);

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const autoPauseRun = await fixture.submit({
        conversationId,
        text: "本轮结束时没有写终态",
        mode: "agent",
        submittedAt: 7
      });
      session.finishSuccessful("本轮回答结束");
      assert.equal((await autoPauseRun.result).terminalState, "completed");
      assert.equal(
        latestTaskPlanFromBranch(
          session.sessionManager.getBranch(),
          pending.planId
        )?.status,
        "paused"
      );
      assert.equal(
        fixture.runtime.releaseProductRun(autoPauseRun.productRunId),
        true
      );

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const abortedRun = await fixture.submit({
        conversationId,
        text: "Provider 自行中断时收口计划",
        mode: "agent",
        submittedAt: 8
      });
      session.finishAborted();
      assert.equal((await abortedRun.result).terminalState, "cancelled");
      const interrupted = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(interrupted?.status, "paused");
      assert.equal(interrupted?.steps[0]?.status, "paused");
      assert.match(interrupted?.lastUpdateSummary ?? "", /已中断/u);
      assert.equal(
        fixture.runtime.releaseProductRun(abortedRun.productRunId),
        true
      );

      await fixture.runtime.transitionTaskPlan({
        conversationId,
        planId: pending.planId,
        action: "continue"
      });
      const failedRun = await fixture.submit({
        conversationId,
        text: "本轮 Provider 失败时收口计划",
        mode: "agent",
        submittedAt: 9
      });
      session.finishFailed("fixture provider failure");
      assert.equal((await failedRun.result).terminalState, "failed");
      const failed = latestTaskPlanFromBranch(
        session.sessionManager.getBranch(),
        pending.planId
      );
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.currentStepId, undefined);
      assert.equal(failed?.steps[0]?.status, "interrupted");
      assert.equal(failed?.steps[1]?.status, "pending");
      assert.equal(
        failed?.steps.some((step) => step.status === "failed"),
        false,
        "whole-run failure must not fabricate a failed step"
      );
      assert.equal(
        fixture.runtime.releaseProductRun(failedRun.productRunId),
        true
      );

      await fixture.runtime.releaseConversation(conversationId);
      const reopened = await fixture.runtime.activateConversation(conversationId);
      const reopenedPlan = reopened.messages.find((message) =>
        message.taskPlan?.planId === pending.planId
      )?.taskPlan;
      assert.equal(reopenedPlan?.status, "failed");
      assert.equal(reopenedPlan?.steps[0]?.status, "interrupted");
    }
  );
}

async function assertAgentSessionWarningsUseConversationSupport(): Promise<void> {
  await withFixture([], async (fixture) => {
    const conversationId = "agent-session-resource-warning";
    const catalog = await fixture.runtime.createConversation({
      conversationId,
      title: "Agent session resource warning",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.catalog.appendDiagnostic({
      diagnosticId: "existing-runtime-diagnostic",
      conversationId,
      piSessionId: catalog.piSessionId,
      code: "runtime_interrupted",
      message: "existing diagnostic",
      createdAt: 3
    });
    fixture.setFactoryWarnings([
      "Fixture MCP Server 已断线。",
      "Fixture MCP\nServer 已断线。"
    ]);
    await fixture.runtime.activateConversation(conversationId);

    const support = await fixture.runtime.readConversationSupportState(conversationId);
    const resourceWarnings = support.diagnostics.filter((diagnostic) =>
      diagnostic.code === "runtime_resource_warning"
    );
    assert.equal(resourceWarnings.length, 1);
    assert.equal(resourceWarnings[0]?.message, "Fixture MCP Server 已断线。");
    assert.ok(support.diagnostics.some((diagnostic) =>
      diagnostic.diagnosticId === "existing-runtime-diagnostic"
    ));
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(
      projection.messages.some((message) =>
        message.text === "Fixture MCP Server 已断线。"
      ),
      false,
      "resource warnings stay in the existing support panel instead of duplicating timeline messages"
    );

    await fixture.runtime.releaseConversation(conversationId);
    fixture.setFactoryWarnings([]);
    await fixture.runtime.activateConversation(conversationId);
    const recovered = await fixture.runtime.readConversationSupportState(conversationId);
    assert.equal(
      recovered.diagnostics.some((diagnostic) =>
        diagnostic.code === "runtime_resource_warning"
      ),
      false,
      "resolved runtime warnings must not remain stale after AgentSession rebuild"
    );
    assert.ok(recovered.diagnostics.some((diagnostic) =>
      diagnostic.diagnosticId === "existing-runtime-diagnostic"
    ));
  });
}

export async function runPiNativeDurableSettlementProjectionRegressionTest():
Promise<void> {
  await withFixture(["run-durable-settlement-projection"], async (fixture) => {
    const conversationId = "durable-settlement-projection";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Durable settlement projection",
      cwd: fixture.root,
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    session.enableRuntimeMessageTimestampDrift();

    const handle = await fixture.submit({
      conversationId,
      text: "durable user message",
      submittedAt: 3
    });
    session.finishSuccessful("durable assistant message");

    const settled = await handle.result;
    assert.equal(settled.state, "product_run_settled");
    assert.equal(settled.terminalState, "completed");
    const projection = await fixture.runtime.readProjection(conversationId);
    assert.ok(projection.messages.some((message) =>
      message.role === "user" && message.text === "durable user message"
    ));
    assert.ok(projection.messages.some((message) =>
      message.role === "assistant" && message.text === "durable assistant message"
    ));
    assert.equal(
      projection.messages.some((message) => message.id.includes("provisional")),
      false,
      "agent_settled must rebuild from durable Pi Entries even when live timestamps drift"
    );
    assert.equal(
      (await fixture.catalog.diagnostics(conversationId)).some(
        (diagnostic) => diagnostic.message.includes("provisional entries")
      ),
      false
    );
  });
}

async function assertNormalMemoryTurnResolvesExplicitProjectIdentity():
Promise<void> {
  const cases = [{
    id: "punctuated-line-directive",
    query: "PROFILE-P01-ON-20C8-R2.\nProject: EchoInk.\nEvidence: provider preflight passed.",
    expectedProjectId: "EchoInk"
  }, {
    id: "line-directive",
    query: "Check the project binding.\nProject：EchoInk\nContinue with the request.",
    expectedProjectId: "EchoInk"
  }, {
    id: "repeated-same-directive",
    query: "Project: EchoInk.\nProject: EchoInk.",
    expectedProjectId: "EchoInk"
  }, {
    id: "conflicting-directives",
    query: "Project: EchoInk.\nProject: Garden.",
    expectedProjectId: undefined
  }, {
    id: "wrong-project",
    query: "Project: Garden.\nShould EchoInk memory be excluded?",
    expectedProjectId: "Garden"
  }, {
    id: "invalid-suffix",
    query: "Project: EchoInk/Other.",
    expectedProjectId: undefined
  }, {
    id: "invalid-character",
    query: "Project: Echo@Ink.",
    expectedProjectId: undefined
  }, {
    id: "overlong-project",
    query: `Project: ${"A".repeat(81)}.`,
    expectedProjectId: undefined
  }, {
    id: "not-project-prefix",
    query: "notProject: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "quoted-literal",
    query: "Quote this literal: Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "fenced-code",
    query: "```text\nProject: EchoInk.\n```",
    expectedProjectId: undefined
  }, {
    id: "indented-code",
    query: "    Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "numbered-example",
    query: "1. Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "blockquote-example",
    query: "> Project: EchoInk.",
    expectedProjectId: undefined
  }, {
    id: "ordinary-chinese-prose",
    query: "项目 EchoInk 的普通正文，不是身份指令。",
    expectedProjectId: undefined
  }, {
    id: "missing-directive",
    query: "Draft a Project plan for EchoInk without an explicit identity label.",
    expectedProjectId: undefined
  }, {
    id: "directive-before-memory-boundary",
    query: `${"x".repeat(3_950)}.\nProject: EchoInk.\nBOUNDARY_SENTINEL`,
    expectedProjectId: "EchoInk"
  }, {
    id: "directive-after-memory-boundary",
    query: `${"x".repeat(4_010)}.\nProject: EchoInk.\nBOUNDARY_SENTINEL`,
    expectedProjectId: "EchoInk"
  }] as const;
  await withFixture(
    cases.map((testCase) => `run-memory-project-${testCase.id}`),
    async (fixture) => {
      const conversationId = "memory-project-identity";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Memory project identity",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);

      for (const testCase of cases) {
        const handle = await fixture.submit({
          conversationId,
          text: testCase.query,
          submittedAt: 3
        });
        const turn = fixture.currentMemoryTurn();
        assert.ok(turn, "ordinary Pi Chat must bind a current Memory Turn");
        assert.equal(turn.query, testCase.query);
        const actualProjectId = "projectId" in turn
          ? turn.projectId
          : undefined;
        assert.equal(
          actualProjectId,
          testCase.expectedProjectId,
          testCase.id
        );
        fixture.latestSession().finishSuccessful(
          "memory project identity checked"
        );
        await handle.result;
      }
    }
  );
}

async function assertDurableDraftRequiresExplicitSuccessfulResubmission():
Promise<void> {
  await withFixture(["run-draft-resubmit"], async (fixture) => {
    const conversationId = "draft-resubmit-conversation";
    const catalog = await fixture.runtime.createConversation({
      conversationId,
      title: "Draft resubmission",
      cwd: fixture.root,
      createdAt: 2
    });
    const draft = await fixture.catalog.upsertDraft({
      draftId: "draft-restart-1",
      conversationId,
      piSessionId: catalog.piSessionId,
      source: "restart",
      text: "unconsumed follow-up",
      createdAt: 3
    });
    const supportBefore = await fixture.runtime.readConversationSupportState(
      conversationId
    );
    assert.deepEqual(supportBefore.drafts, [draft]);
    const reopenedCatalog = new FileConversationCatalog({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await reopenedCatalog.initialize();
    assert.deepEqual(
      await reopenedCatalog.drafts(conversationId),
      [draft],
      "a fresh Catalog instance must recover the draft without executing it"
    );

    await fixture.runtime.activateConversation(conversationId);
    fixture.latestSession().failNextPrompt(new Error("prompt start rejected"));
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "edited but not durably submitted",
        draftId: draft.draftId,
        submittedAt: 4
      }),
      /prompt start rejected/u
    );
    assert.deepEqual(
      (await fixture.runtime.readConversationSupportState(conversationId)).drafts,
      [draft],
      "a prompt that never durably appends its user Entry must retain the draft"
    );

    const handle = await fixture.submit({
      conversationId,
      text: "edited and explicitly resubmitted",
      draftId: draft.draftId,
      submittedAt: 5
    });
    assert.deepEqual(
      (await fixture.runtime.readConversationSupportState(conversationId)).drafts,
      [],
      "the draft must be consumed only after the user Entry is durable"
    );
    assert.ok(fixture.latestSession().sessionManager.getEntries().some(
      (entry) =>
        entry.type === "message"
        && entry.message.role === "user"
        && entry.message.content === "edited and explicitly resubmitted"
    ));
    fixture.latestSession().finishSuccessful("draft accepted");
    assert.equal((await handle.result).terminalState, "completed");

    const disposable = await fixture.catalog.upsertDraft({
      draftId: "draft-discard-1",
      conversationId,
      piSessionId: catalog.piSessionId,
      source: "abort",
      text: "delete me",
      createdAt: 6
    });
    assert.equal(
      await fixture.runtime.discardDraft(conversationId, disposable.draftId),
      true
    );
    assert.equal(
      await fixture.runtime.discardDraft(conversationId, disposable.draftId),
      false
    );
    const reopenedAfterDiscard = new FileConversationCatalog({
      storageRootPath: fixture.catalog.storageRootPath,
      vaultId: fixture.catalog.vaultId
    });
    await reopenedAfterDiscard.initialize();
    assert.deepEqual(
      await reopenedAfterDiscard.drafts(conversationId),
      [],
      "a discarded draft must not reappear after a fresh Catalog open"
    );
  });
}

async function assertImagePromptsRequireCapabilityAndPreserveOrder():
Promise<void> {
  const orderedImages = [
    preparedImage("first.png", "/fixture/first.png", "image/png", "AQID"),
    preparedImage("second.jpg", "/fixture/second.jpg", "image/jpeg", "BAUG")
  ] as const;

  await withFixture(
    ["run-image-text", "run-image-only"],
    async (fixture) => {
      const conversationId = "image-capable-conversation";
      await fixture.runtime.createConversation({
        conversationId,
        title: "Image capable",
        cwd: fixture.root,
        createdAt: 2
      });
      await fixture.runtime.activateConversation(conversationId);
      const session = fixture.latestSession();
      session.model.input = ["text", "image"];

      const textAndImages = await fixture.submit({
        conversationId,
        text: "按顺序看这两张图",
        images: orderedImages,
        submittedAt: 3
      });
      assert.deepEqual(session.promptTexts, ["按顺序看这两张图"]);
      assert.deepEqual(session.promptImages[0], [
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "image", data: "BAUG", mimeType: "image/jpeg" }
      ]);
      const firstUserMessage = session.sessionManager.getEntries().find(
        (entry) => entry.id === textAndImages.userEntryId
      );
      assert.equal(firstUserMessage?.type, "message");
      if (firstUserMessage?.type === "message") {
        assert.deepEqual(firstUserMessage.message.content, [
          { type: "text", text: "按顺序看这两张图" },
          { type: "image", data: "AQID", mimeType: "image/png" },
          { type: "image", data: "BAUG", mimeType: "image/jpeg" }
        ]);
      }
      session.finishSuccessful("看到了两张图");
      assert.equal((await textAndImages.result).terminalState, "completed");
      assert.equal(
        fixture.runtime.releaseProductRun(textAndImages.productRunId),
        true
      );

      const pureImage = await fixture.submit({
        conversationId,
        text: "",
        images: [orderedImages[1]],
        submittedAt: 4
      });
      assert.equal(session.promptTexts[1], "");
      assert.deepEqual(session.promptImages[1], [
        { type: "image", data: "BAUG", mimeType: "image/jpeg" }
      ]);
      const pureImageUserMessage = session.sessionManager.getEntries().find(
        (entry) => entry.id === pureImage.userEntryId
      );
      assert.equal(pureImageUserMessage?.type, "message");
      if (pureImageUserMessage?.type === "message") {
        assert.deepEqual(pureImageUserMessage.message.content, [
          { type: "text", text: "" },
          { type: "image", data: "BAUG", mimeType: "image/jpeg" }
        ]);
      }
      session.finishSuccessful("纯图片也已接收");
      assert.equal((await pureImage.result).terminalState, "completed");
      assert.equal(fixture.runtime.releaseProductRun(pureImage.productRunId), true);
    }
  );

  await withFixture(["run-image-must-not-start"], async (fixture) => {
    const conversationId = "image-incapable-conversation";
    await fixture.runtime.createConversation({
      conversationId,
      title: "Image incapable",
      cwd: fixture.root,
      createdAt: 5
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();

    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "不能发送",
        images: [orderedImages[0]],
        submittedAt: 6
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "image_input_unsupported"
        && error.message === PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE
        && error.piUserEntryAccepted === false
        && error.piUserEntryId === undefined
    );
    assert.deepEqual(session.promptTexts, []);
    assert.deepEqual(session.promptImages, []);
    assert.deepEqual(await fixture.productRuns.list(conversationId), []);
    assert.deepEqual(session.lifecycleCalls, []);
  });
}

async function assertVerifiedPrefixRecoveryIsExplicitAndFailClosed():
Promise<void> {
  await withFixture(["run-recovery"], async (fixture) => {
    const conversationId = "recovery-conversation";
    const userText = "durable user entry before JSONL corruption";
    const handle = await fixture.submit({
      conversationId,
      text: userText,
      submittedAt: 3
    });
    await assert.rejects(
      fixture.runtime.recoverConversationFromVerifiedPrefix({
        conversationId,
        recoveryPath: path.join(
          fixture.catalog.sessionRootPath,
          "must-not-recover-while-running.jsonl"
        )
      }),
      conversationBusyError
    );

    fixture.latestSession().finishSuccessful("durable assistant entry");
    assert.equal((await handle.result).terminalState, "completed");
    const expectedActiveLeafId = fixture.latestSession()
      .sessionManager.getLeafId();
    assert.ok(expectedActiveLeafId);
    assert.equal(fixture.runtime.releaseProductRun(handle.productRunId), true);
    await fixture.runtime.releaseConversation(conversationId);

    const beforeCorruption = await fixture.catalog.get(conversationId);
    assert.ok(beforeCorruption?.sessionFile);
    assert.equal(beforeCorruption.piSessionId, handle.piSessionId);
    const sourcePath = beforeCorruption.sessionFile;
    await appendFile(sourcePath, "not-json\n");
    const corruptSourceBytes = await readFile(sourcePath);

    await assert.rejects(
      fixture.runtime.readProjection(conversationId),
      sessionJsonlInvalidError
    );
    await assert.rejects(
      fixture.runtime.readProjection(conversationId),
      sessionJsonlInvalidError
    );
    const diagnosticsBeforeRecovery = await fixture.catalog.diagnostics(
      conversationId
    );
    assert.equal(
      diagnosticsBeforeRecovery.filter(
        (diagnostic) => diagnostic.code === "session_jsonl_malformed"
      ).length,
      1,
      "repeated opens must dedupe the same corruption diagnostic"
    );
    const recoveryDiagnostics = diagnosticsBeforeRecovery.filter(
      (diagnostic) => diagnostic.code === "session_recovered_prefix"
    );
    assert.equal(
      recoveryDiagnostics.length,
      2,
      "each generated recovery file must retain its own provenance"
    );
    const recoveryDiagnostic = recoveryDiagnostics.at(-1);
    assert.ok(recoveryDiagnostic?.recoveryPath);
    assert.equal(recoveryDiagnostic.sourcePath, sourcePath);
    const recoveryPath = recoveryDiagnostic.recoveryPath;

    const unprovenRecoveryPath = path.join(
      fixture.catalog.sessionRootPath,
      "unproven-recovery-copy.jsonl"
    );
    await copyFile(recoveryPath, unprovenRecoveryPath);
    await assert.rejects(
      fixture.runtime.recoverConversationFromVerifiedPrefix({
        conversationId,
        recoveryPath: unprovenRecoveryPath
      }),
      sessionRecoveryInvalidError
    );
    assert.equal(
      await fixture.catalog.sessionFile(conversationId),
      sourcePath,
      "an unproven copy must not change the Catalog pointer"
    );

    const recovered = await fixture.runtime.recoverConversationFromVerifiedPrefix({
      conversationId,
      recoveryPath
    });
    assert.equal(recovered.catalog.piSessionId, handle.piSessionId);
    assert.equal(recovered.catalog.sessionFile, recoveryPath);
    assert.equal(recovered.sourcePath, sourcePath);
    assert.equal(recovered.recoveryPath, recoveryPath);
    assert.ok(recovered.recoveredEntryCount >= 1);
    assert.equal(recovered.activeLeafId, expectedActiveLeafId);
    assert.deepEqual(
      await readFile(sourcePath),
      corruptSourceBytes,
      "verified-prefix recovery must preserve the corrupt source byte-for-byte"
    );
    assert.equal(await fixture.catalog.sessionFile(conversationId), recoveryPath);

    const pointerBeforeStaleCas = await fixture.catalog.sessionFile(
      conversationId
    );
    await assert.rejects(
      fixture.catalog.adoptVerifiedRecoverySessionFile({
        conversationId,
        piSessionId: handle.piSessionId,
        expectedSessionFile: sourcePath,
        recoverySessionFile: unprovenRecoveryPath
      }),
      mappingConflictError
    );
    assert.equal(
      await fixture.catalog.sessionFile(conversationId),
      pointerBeforeStaleCas,
      "a stale recovery CAS must leave the Catalog pointer unchanged"
    );

    const projection = await fixture.runtime.readProjection(conversationId);
    assert.equal(projection.catalog.piSessionId, handle.piSessionId);
    assert.equal(projection.catalog.sessionFile, recoveryPath);
    assert.equal(projection.activeLeafId, expectedActiveLeafId);
    assert.ok(projection.messages.some(
      (message) => message.role === "user" && message.text === userText
    ));
    assert.deepEqual(
      (await fixture.catalog.diagnostics(conversationId)).map(
        (diagnostic) => diagnostic.diagnosticId
      ),
      diagnosticsBeforeRecovery.map((diagnostic) => diagnostic.diagnosticId),
      "recovery must retain the original corruption diagnostics"
    );
  });
}

async function assertExperienceSourceRefsArePointerOnlyAndDeleteAware():
Promise<void> {
  const capturedDreamExperiences: Array<Parameters<NonNullable<
    PiNativeConversationRuntimeOptions["recordDreamExperience"]
  >>[0]> = [];
  await withFixture(
    ["run-experience-normal", "run-experience-no-memory"],
    async (fixture) => {
      assert.equal(
        await fixture.runtime.readExperienceSourceRef("run-missing"),
        null
      );

      const normal = await fixture.submit({
        conversationId: "experience-normal",
        text: "normal source",
        submittedAt: 4,
        memoryMode: "normal"
      });
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        null,
        "an unsettled ProductRun must not expose an Experience source"
      );
      fixture.latestSession().finishSuccessful("normal answer");
      await normal.result;
      assert.equal(capturedDreamExperiences.length, 1);
      assert.equal(capturedDreamExperiences[0]?.productRunId, normal.productRunId);

      const first = await fixture.runtime.readExperienceSourceRef(
        normal.productRunId
      );
      const repeated = await fixture.runtime.readExperienceSourceRef(
        normal.productRunId
      );
      assert.ok(first);
      assert.deepEqual(repeated, first);
      assert.deepEqual(Object.keys(first).sort(), [
        "assistantEntryId",
        "conversationId",
        "memoryMode",
        "piSessionId",
        "productRunId",
        "sourceEventId",
        "terminalState",
        "userEntryId",
        "vaultId"
      ]);
      assert.equal(first.memoryMode, "normal");
      assert.equal(first.terminalState, "completed");
      assert.equal(first.productRunId, normal.productRunId);
      assert.equal(first.userEntryId, normal.userEntryId);
      assert.equal(first.piSessionId, normal.piSessionId);
      assert.match(first.sourceEventId, /^experience-source-[a-f0-9]{32}$/u);

      await fixture.runtime.setConversationStatus(
        normal.conversationId,
        "archived"
      );
      assert.deepEqual(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        first,
        "archiving must retain the source pointer"
      );
      await fixture.runtime.setConversationStatus(
        normal.conversationId,
        "deleted"
      );
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(normal.productRunId),
        null,
        "deleting the Conversation must invalidate the source pointer"
      );

      const noMemory = await fixture.submit({
        conversationId: "experience-no-memory",
        text: "ephemeral source",
        submittedAt: 5,
        memoryMode: "no_memory"
      });
      fixture.latestSession().finishSuccessful("ephemeral answer");
      await noMemory.result;
      assert.equal(
        await fixture.runtime.readExperienceSourceRef(noMemory.productRunId),
        null,
        "no_memory ProductRuns must not publish Experience source pointers"
      );
      assert.equal(capturedDreamExperiences.length, 1,
        "no_memory ProductRuns must not enter the Dream public inbox");
    },
    {
      recordDreamExperience: async (experience) => {
        capturedDreamExperiences.push(experience);
      }
    }
  );
}

async function assertSkillPromptAndBindingValidation(): Promise<void> {
  await withFixture(
    ["run-skill", "run-plain"],
    async (fixture) => {
      await assert.rejects(
        fixture.submit({
          conversationId: "invalid-submit",
          text: "must not create",
          submittedAt: 1,
          skillPath: path.join(fixture.root, "review", "SKILL.md")
        }),
        skillBindingError
      );
      assert.equal(await fixture.catalog.get("invalid-submit"), null);

      await fixture.runtime.createConversation({
        conversationId: "invalid-activate",
        title: "Invalid activate",
        cwd: fixture.root
      });
      await assert.rejects(
        fixture.runtime.activateConversation("invalid-activate", {
          skillName: "review"
        }),
        skillBindingError
      );

      const skillHandle = await fixture.submit({
        conversationId: "skill-conversation",
        text: "hello",
        submittedAt: 2,
        skillPath: path.join(fixture.root, "review", "SKILL.md"),
        skillName: "Phase 1 Acceptance"
      });
      const skillSession = fixture.latestSession();
      assert.deepEqual(skillSession.promptTexts, [
        "/skill:echoink-selected-skill hello"
      ]);
      assert.equal(fixture.runtime.releaseProductRun(skillHandle.productRunId), false);
      skillSession.finishSuccessful("skill answer");
      assert.equal((await skillHandle.result).state, "product_run_settled");
      assert.equal(fixture.runtime.releaseProductRun(skillHandle.productRunId), true);

      const plainHandle = await fixture.submit({
        conversationId: "plain-conversation",
        text: "plain text",
        submittedAt: 3
      });
      const plainSession = fixture.latestSession();
      assert.deepEqual(plainSession.promptTexts, ["plain text"]);
      plainSession.finishSuccessful("plain answer");
      assert.equal((await plainHandle.result).terminalState, "completed");
      assert.equal(fixture.runtime.releaseProductRun(plainHandle.productRunId), true);
    }
  );
}

async function assertProductRunCreateFailureCleansRuntime(): Promise<void> {
  await assertProductRunPersistenceFailure("create");
}

async function assertProductRunMarkRunningFailureCleansRuntime(): Promise<void> {
  await assertProductRunPersistenceFailure("mark_running");
}

async function assertProductRunPersistenceFailure(
  stage: "create" | "mark_running"
): Promise<void> {
  const failedRunId = `run-${stage}-failure`;
  await withFixture(
    [failedRunId, `run-${stage}-retry`],
    async (fixture) => {
      const storageError = stage === "create"
        ? new Error(
            "SECRET_CREATE user=PRIVATE apiKey=sk-private path=/Users/private"
          )
        : new PiNativeFileStoreError(
            "invalid-transition",
            "SECRET_MARK_RUNNING provider response and /Users/private"
          );
      const store = fixture.productRuns;
      const originalCreate = store.create.bind(store);
      const originalUpdate = store.update.bind(store);
      if (stage === "create") {
        let fail = true;
        store.create = async (input) => {
          if (fail) {
            fail = false;
            throw storageError;
          }
          return await originalCreate(input);
        };
      } else {
        let fail = true;
        store.update = async (productRunId, update) => {
          if (fail) {
            fail = false;
            throw storageError;
          }
          return await originalUpdate(productRunId, update);
        };
      }

      let acceptedFailure: PiNativeConversationRuntimeError | null = null;
      await assert.rejects(
        fixture.submit({
          conversationId: `${stage}-failure-conversation`,
          text: "first attempt",
          submittedAt: 10
        }),
        (error: unknown) => {
          if (!(error instanceof PiNativeConversationRuntimeError)) return false;
          acceptedFailure = error;
          return error.code === "product_run_start_failed_after_user_entry"
            && error.piUserEntryAccepted === true
            && Boolean(error.piUserEntryId)
            && error.cause === storageError;
        }
      );
      const session = fixture.latestSession();
      assert.equal(session.promptTexts.length, 1, "Provider must run once");
      assert.ok(session.sessionManager.getEntries().some(
        (entry) => entry.id === acceptedFailure?.piUserEntryId
      ));
      assert.equal(
        reasoningSummariesForRun(session.sessionManager, failedRunId)
          .at(-1)?.status,
        "failed"
      );
      assert.deepEqual(session.lifecycleCalls, [
        "clearQueue",
        "abort",
        "waitForIdle"
      ]);
      assert.throws(
        () => fixture.runtime.subscribeProductRun(failedRunId, () => undefined),
        unavailableRunError
      );
      const expectedDiagnosticStage = stage === "create"
        ? "product_run_create"
        : "product_run_mark_running";
      const expectedSafeCode = stage === "create"
        ? "unknown"
        : "invalid-transition";
      await assertSafeStartFailureDiagnostic(
        fixture,
        `${stage}-failure-conversation`,
        `pi_native_start_failed:${expectedDiagnosticStage}:${expectedSafeCode}`,
        ["SECRET", "PRIVATE", "sk-private", "/Users/private", "provider response"]
      );
      const failedRuns = await fixture.productRuns.list(
        `${stage}-failure-conversation`
      );
      if (stage === "create") {
        assert.deepEqual(failedRuns, [], "create failure must leave no ProductRun");
      } else {
        assert.equal(failedRuns.length, 1);
        assert.equal(failedRuns[0]?.productRunId, failedRunId);
        assert.equal(failedRuns[0]?.state, "accepted");
      }

      const retry = await fixture.submit({
        conversationId: `${stage}-failure-conversation`,
        text: "second attempt",
        submittedAt: 11
      });
      session.finishSuccessful("retry answer");
      assert.equal((await retry.result).terminalState, "completed");
      assert.equal(fixture.runtime.releaseProductRun(retry.productRunId), true);
    }
  );
}

async function assertUserEntryReadbackFailureIsSafelyDiagnosed(): Promise<void> {
  await withFixture(["run-user-readback-failure"], async (fixture) => {
    const conversationId = "user-readback-failure-conversation";
    await fixture.runtime.createConversation({
      conversationId,
      title: "User readback failure",
      cwd: fixture.root,
      createdAt: 1
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    session.corruptSessionJsonlAfterNextUserEntry();

    let primaryReadbackError: PiSessionDurabilityError | null = null;
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "PRIVATE_USER_MESSAGE",
        submittedAt: 2
      }),
      (error: unknown) => {
        const primaryError = error instanceof AggregateError
          ? error.errors[0]
          : error;
        if (!(primaryError instanceof PiSessionDurabilityError)) return false;
        primaryReadbackError = primaryError;
        return primaryError.code === "pi_session_jsonl_invalid";
      }
    );

    assert.equal(session.promptTexts.length, 1);
    assert.equal(primaryReadbackError?.code, "pi_session_jsonl_invalid");
    assert.ok(session.sessionManager.getEntries().some(
      (entry) => entry.type === "message" && entry.message.role === "user"
    ));
    assert.match(await readFile(session.sessionFile!, "utf8"), /not-json/u);
    assert.deepEqual(await fixture.productRuns.list(conversationId), []);
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        "run-user-readback-failure"
      ).at(-1)?.status,
      "failed"
    );
    await assertSafeStartFailureDiagnostic(
      fixture,
      conversationId,
      "pi_native_start_failed:user_entry_readback:pi_session_jsonl_invalid",
      ["PRIVATE_USER_MESSAGE", "not-json"]
    );
  });
}

async function assertDraftRemoveFailureIsSafelyDiagnosed(): Promise<void> {
  await withFixture(["run-draft-remove-failure"], async (fixture) => {
    const conversationId = "draft-remove-failure-conversation";
    const catalog = await fixture.runtime.createConversation({
      conversationId,
      title: "Draft remove failure",
      cwd: fixture.root,
      createdAt: 1
    });
    const draft = await fixture.catalog.upsertDraft({
      draftId: "draft-remove-failure",
      conversationId,
      piSessionId: catalog.piSessionId,
      source: "restart",
      text: "PRIVATE_DRAFT_BODY",
      createdAt: 2
    });
    await fixture.runtime.activateConversation(conversationId);
    const session = fixture.latestSession();
    const storageError = new PiNativeFileStoreError(
      "readback-diverged",
      "SECRET_DRAFT PRIVATE_MEMORY /Users/private"
    );
    const originalRemoveDraft = fixture.catalog.removeDraft.bind(fixture.catalog);
    fixture.catalog.removeDraft = async () => {
      fixture.catalog.removeDraft = originalRemoveDraft;
      throw storageError;
    };

    let acceptedFailure: PiNativeConversationRuntimeError | null = null;
    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "PRIVATE_DRAFT_RESUBMISSION",
        draftId: draft.draftId,
        submittedAt: 3
      }),
      (error: unknown) => {
        if (!(error instanceof PiNativeConversationRuntimeError)) return false;
        acceptedFailure = error;
        return error.code === "product_run_start_failed_after_user_entry"
          && error.piUserEntryAccepted === true
          && Boolean(error.piUserEntryId)
          && error.cause === storageError;
      }
    );

    assert.equal(session.promptTexts.length, 1);
    assert.ok(session.sessionManager.getEntries().some(
      (entry) => entry.id === acceptedFailure?.piUserEntryId
    ));
    assert.deepEqual(await fixture.productRuns.list(conversationId), []);
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        "run-draft-remove-failure"
      ).at(-1)?.status,
      "failed"
    );
    assert.deepEqual(await fixture.catalog.drafts(conversationId), [draft]);
    await assertSafeStartFailureDiagnostic(
      fixture,
      conversationId,
      "pi_native_start_failed:draft_remove:readback-diverged",
      ["SECRET_DRAFT", "PRIVATE_MEMORY", "PRIVATE_DRAFT_BODY", "PRIVATE_DRAFT_RESUBMISSION", "/Users/private"]
    );
  });
}

async function assertProductRunStartDiagnosticFailureDoesNotMaskCause():
Promise<void> {
  await withFixture(["run-start-diagnostic-failure"], async (fixture) => {
    const conversationId = "start-diagnostic-failure-conversation";
    const storageError = new PiNativeFileStoreError(
      "store-corrupt",
      "ORIGINAL_PRIVATE_STORAGE_ERROR"
    );
    const diagnosticError = new Error("DIAGNOSTIC_STORE_FAILURE");
    fixture.productRuns.create = async () => {
      throw storageError;
    };
    fixture.catalog.appendDiagnostic = async () => {
      throw diagnosticError;
    };

    await assert.rejects(
      fixture.submit({
        conversationId,
        text: "diagnostic failure must not mask cause",
        submittedAt: 4
      }),
      (error: unknown) => error instanceof PiNativeConversationRuntimeError
        && error.code === "product_run_start_failed_after_user_entry"
        && error.piUserEntryAccepted === true
        && Boolean(error.piUserEntryId)
        && error.cause === storageError
    );

    const session = fixture.latestSession();
    assert.equal(session.promptTexts.length, 1);
    assert.deepEqual(await fixture.productRuns.list(conversationId), []);
    assert.equal(
      reasoningSummariesForRun(
        session.sessionManager,
        "run-start-diagnostic-failure"
      ).at(-1)?.status,
      "failed"
    );
  });
}

async function assertTamperedProductRunStartCodesAreRedacted(): Promise<void> {
  const cases: ReadonlyArray<Readonly<{
    suffix: string;
    error: Error;
    sensitiveCode: string;
  }>> = [
    {
      suffix: "runtime",
      error: new PiNativeConversationRuntimeError(
        "conversation_busy",
        "runtime error with a safe constructor code"
      ),
      sensitiveCode: "SECRET_RUNTIME_CODE_sk-private_/Users/private"
    },
    {
      suffix: "session",
      error: new PiSessionDurabilityError({
        code: "pi_session_readback_mismatch",
        message: "session error with a safe constructor code"
      }),
      sensitiveCode: "SECRET_SESSION_CODE_sk-private_/Users/private"
    },
    {
      suffix: "store",
      error: new PiNativeFileStoreError(
        "store-corrupt",
        "store error with a safe constructor code"
      ),
      sensitiveCode: "SECRET_STORE_CODE_sk-private_/Users/private"
    }
  ];
  await withFixture(
    cases.map(({ suffix }) => `run-sensitive-${suffix}`),
    async (fixture) => {
      for (const testCase of cases) {
        Object.defineProperty(testCase.error, "code", {
          value: testCase.sensitiveCode,
          configurable: true
        });
        fixture.productRuns.create = async () => {
          throw testCase.error;
        };
        const conversationId = `sensitive-${testCase.suffix}-conversation`;

        await assert.rejects(
          fixture.submit({
            conversationId,
            text: `sensitive ${testCase.suffix} code`,
            submittedAt: 5
          }),
          (error: unknown) =>
            error instanceof PiNativeConversationRuntimeError
            && error.code === "product_run_start_failed_after_user_entry"
            && error.cause === testCase.error
        );

        await assertSafeStartFailureDiagnostic(
          fixture,
          conversationId,
          "pi_native_start_failed:product_run_create:unknown",
          [testCase.sensitiveCode, "sk-private", "/Users/private"]
        );
      }
    }
  );
}

async function assertSuccessfulProductRunDoesNotWriteStartDiagnostic():
Promise<void> {
  await withFixture(["run-start-diagnostic-success"], async (fixture) => {
    const conversationId = "start-diagnostic-success-conversation";
    const handle = await fixture.submit({
      conversationId,
      text: "successful start",
      submittedAt: 5
    });
    fixture.latestSession().finishSuccessful("successful answer");
    assert.equal((await handle.result).terminalState, "completed");
    assert.equal(
      (await fixture.catalog.diagnostics(conversationId)).some(
        (diagnostic) => diagnostic.message.startsWith("pi_native_start_failed:")
      ),
      false
    );
  });
}

async function assertSafeStartFailureDiagnostic(
  fixture: RuntimeFixture,
  conversationId: string,
  expectedMessage: string,
  forbiddenFragments: readonly string[]
): Promise<void> {
  const diagnostics = (await fixture.catalog.diagnostics(conversationId))
    .filter((diagnostic) =>
      diagnostic.message.startsWith("pi_native_start_failed:")
    );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "runtime_interrupted");
  assert.equal(diagnostics[0]?.message, expectedMessage);
  const serialized = JSON.stringify(diagnostics[0]);
  for (const fragment of forbiddenFragments) {
    assert.equal(serialized.includes(fragment), false);
  }
}

async function assertSubscriberFailuresAreIsolated(): Promise<void> {
  await withFixture(["run-subscriber"], async (fixture) => {
    const handle = await fixture.submit({
      conversationId: "subscriber-conversation",
      text: "subscriber isolation",
      submittedAt: 20
    });
    const orderedEvents: string[] = [];
    let failingSubscriberCalls = 0;
    fixture.runtime.subscribeProductRun(handle.productRunId, async (event) => {
      await Promise.resolve();
      orderedEvents.push(event.type);
    });
    fixture.runtime.subscribeProductRun(handle.productRunId, () => {
      failingSubscriberCalls += 1;
      throw new Error("fixture subscriber failure");
    });

    fixture.latestSession().finishSuccessful("subscriber answer");
    const result = await handle.result;
    assert.equal(result.terminalState, "completed");
    assert.deepEqual(orderedEvents, [
      "reasoning_summary",
      "agent_settled",
      "reasoning_summary",
      "product_run_settled"
    ]);
    assert.equal(failingSubscriberCalls, 4);
    assert.equal(fixture.runtime.releaseProductRun(handle.productRunId), true);
  });
}

async function assertSettlementFailureIsDiagnosedAndReleasesRun(): Promise<void> {
  await withFixture(
    ["run-unsettled", "run-after-unsettled"],
    async (fixture) => {
      const first = await fixture.submit({
        conversationId: "unsettled-conversation",
        text: "first unsettled run",
        submittedAt: 30
      });
      assert.equal(fixture.runtime.releaseProductRun(first.productRunId), false);
      fixture.latestSession().finishSuccessful("first answer");
      await assert.rejects(first.result, pendingProductWorkError);

      const diagnostics = await fixture.catalog.diagnostics(
        "unsettled-conversation"
      );
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, "runtime_interrupted");
      assert.equal(
        diagnostics[0]?.message,
        "pi_native_projection_unsettled",
        "persisted diagnostics must keep a safe code instead of exception text"
      );
      assert.equal(fixture.runtime.releaseProductRun(first.productRunId), true);

      const second = await fixture.submit({
        conversationId: "unsettled-conversation",
        text: "lock was released",
        submittedAt: 31
      });
      assert.equal(fixture.runtime.releaseProductRun(second.productRunId), false);
      fixture.latestSession().finishSuccessful("second answer");
      await assert.rejects(second.result, pendingProductWorkError);
      assert.equal(fixture.runtime.releaseProductRun(second.productRunId), true);
    },
    {
      hasPendingProductWork: async () => true
    }
  );
}

async function assertPromptStartFailureReleasesSettlementBarrier(): Promise<void> {
  await withFixture(["run-prompt-start-failure"], async (fixture) => {
    await fixture.runtime.createConversation({
      conversationId: "prompt-start-failure",
      title: "Prompt start failure",
      cwd: fixture.root
    });
    await fixture.runtime.activateConversation("prompt-start-failure");
    const session = fixture.latestSession();
    const promptStartError = new Error("fixture synchronous prompt failure");
    session.failNextPrompt(promptStartError);

    await assert.rejects(
      fixture.submit({
        conversationId: "prompt-start-failure",
        text: "must fail before the first Entry",
        submittedAt: 40
      }),
      (error: unknown) => error === promptStartError
    );
    assert.deepEqual(session.lifecycleCalls.slice(0, 3), [
      "clearQueue",
      "abort",
      "waitForIdle"
    ]);
    assert.throws(
      () => fixture.runtime.subscribeProductRun(
        "run-prompt-start-failure",
        () => undefined
      ),
      unavailableRunError
    );
    await withTimeout(
      fixture.runtime.releaseConversation("prompt-start-failure"),
      "prompt-start failure release"
    );
    assert.equal(session.disposed, true);
  });
}

async function assertConversationTeardownWaitsForSettlement(
  mode: "release" | "shutdown"
): Promise<void> {
  await withFixture([`run-${mode}-barrier`], async (fixture) => {
    const diagnosticStarted = deferred();
    const allowDiagnostic = deferred();
    const originalAppendDiagnostic = fixture.catalog.appendDiagnostic.bind(
      fixture.catalog
    );
    fixture.catalog.appendDiagnostic = async (diagnostic) => {
      diagnosticStarted.resolve();
      await allowDiagnostic.promise;
      return await originalAppendDiagnostic(diagnostic);
    };

    const conversationId = `${mode}-barrier-conversation`;
    const handle = await fixture.submit({
      conversationId,
      text: `${mode} must await settlement`,
      submittedAt: 50
    });
    const session = fixture.latestSession();
    session.omitAgentSettledOnAbort();
    const resultFailure = assert.rejects(
      handle.result,
      agentSettledMissingError
    );
    const teardown = mode === "release"
      ? fixture.runtime.releaseConversation(conversationId)
      : fixture.runtime.shutdown();
    let teardownFinished = false;
    void teardown.then(
      () => {
        teardownFinished = true;
      },
      () => {
        teardownFinished = true;
      }
    );

    await withTimeout(
      diagnosticStarted.promise,
      `${mode} diagnostic start`
    );
    await Promise.resolve();
    assert.equal(teardownFinished, false);
    assert.equal(session.disposed, false);

    allowDiagnostic.resolve();
    await resultFailure;
    await withTimeout(teardown, `${mode} durable settlement`);
    assert.equal(session.disposed, true);
    const flushIndex = session.lifecycleCalls.indexOf("flush");
    const disposeIndex = session.lifecycleCalls.indexOf("dispose");
    assert.ok(flushIndex > session.lifecycleCalls.lastIndexOf("waitForIdle"));
    assert.ok(disposeIndex > flushIndex);

    const diagnostics = await fixture.catalog.diagnostics(conversationId);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "runtime_interrupted");
    assert.match(diagnostics[0]?.message ?? "", /agent_settled/u);
  });
}

function skillBindingError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "skill_binding_invalid";
}

function conversationBusyError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "conversation_busy";
}

function sessionRecoveryInvalidError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "session_recovery_invalid";
}

function sessionJsonlInvalidError(error: unknown): boolean {
  return error instanceof PiSessionDurabilityError
    && error.code === "pi_session_jsonl_invalid";
}

function mappingConflictError(error: unknown): boolean {
  return error instanceof PiNativeFileStoreError
    && error.code === "mapping-conflict";
}

function unavailableRunError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "conversation_not_found";
}

function pendingProductWorkError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "projection_unsettled"
    && /pending Approval, Receipt, or product work/u.test(error.message);
}

function agentSettledMissingError(error: unknown): boolean {
  return error instanceof PiNativeConversationRuntimeError
    && error.code === "agent_settled_missing";
}

interface RuntimeFixture {
  root: string;
  catalog: FileConversationCatalog;
  productRuns: FileProductRunStore;
  runtime: PiNativeConversationRuntime;
  submit(
    request: RuntimeFixtureSubmitRequest
  ): ReturnType<PiNativeConversationRuntime["submit"]>;
  sessions: ControlledAgentSession[];
  failNextActivation(error: Error): void;
  setFactoryWarnings(warnings: readonly string[]): void;
  setMemoryToolNames(names: readonly string[]): void;
  configureFactoryTools(input: Readonly<{
    registered: readonly string[];
    defaults: readonly string[];
    planAllowed: readonly string[];
    externalReadAllowed?: readonly string[];
  }>): void;
  currentMemoryTurn(): Readonly<PiNativeMemoryTurnContext> | null;
  currentKnowledgeTurn(): Readonly<PiNativeKnowledgeTurnContext> | null;
  currentMaintenanceCommand: NonNullable<PiNativeAgentSessionFactoryInput["currentMaintenanceCommand"]>;
  currentSkillTurn(): Readonly<PiNativeSkillTurnContext> | null;
  currentDocumentTurn(): Readonly<PiNativeDocumentTurnContext> | null;
  currentToolExecution(): ReturnType<
    PiNativeAgentSessionFactoryInput["currentToolExecutionContext"]
  >;
  currentSuccessfulExternalReadTools(): readonly string[];
  reportMemoryRecall(input: Parameters<NonNullable<
    PiNativeAgentSessionFactoryInput["reportMemoryRecallProgress"]
  >>[0]): Promise<void>;
  reportAskPersonalMemorySources(input: Parameters<NonNullable<
    PiNativeAgentSessionFactoryInput["reportAskPersonalMemorySources"]
  >>[0]): Promise<void>;
  latestSession(): ControlledAgentSession;
}

type RuntimeFixtureSubmitRequest = Omit<
  PiChatSubmitRequest,
  "runtimeProviderId" | "modelId" | "reasoning"
> & Partial<Pick<
  PiChatSubmitRequest,
  "runtimeProviderId" | "modelId" | "reasoning"
>>;

async function withFixture(
  runIds: readonly string[],
  assertion: (fixture: RuntimeFixture) => Promise<void>,
  runtimeOptions: Pick<
    PiNativeConversationRuntimeOptions,
    "hasPendingProductWork" | "knowledge" | "now" | "recordDreamExperience" | "skills"
  > = {}
): Promise<void> {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), "echoink-pi-native-runtime-")
  ));
  const sessions: ControlledAgentSession[] = [];
  let currentMemoryTurnReader:
    (() => Readonly<PiNativeMemoryTurnContext> | null) | null = null;
  let currentKnowledgeTurnReader:
    (() => Readonly<PiNativeKnowledgeTurnContext> | null) | null = null;
  let currentMaintenanceCommandReader: PiNativeAgentSessionFactoryInput["currentMaintenanceCommand"];
  let currentSkillTurnReader:
    (() => Readonly<PiNativeSkillTurnContext> | null) | null = null;
  let currentDocumentTurnReader:
    (() => Readonly<PiNativeDocumentTurnContext> | null) | null = null;
  let currentToolExecutionReader:
    PiNativeAgentSessionFactoryInput["currentToolExecutionContext"] | null = null;
  let currentSuccessfulExternalReadToolsReader:
    (() => readonly string[]) | null = null;
  let memoryRecallReporter: PiNativeAgentSessionFactoryInput["reportMemoryRecallProgress"] = undefined;
  let askPersonalMemorySourcesReporter:
    PiNativeAgentSessionFactoryInput["reportAskPersonalMemorySources"] = undefined;
  let nextActivationError: Error | null = null;
  let factoryWarnings: readonly string[] = [];
  let memoryToolNames: readonly string[] = [];
  let factoryTools = {
    registered: [] as readonly string[],
    defaults: [] as readonly string[],
    planAllowed: [] as readonly string[],
    externalReadAllowed: [] as readonly string[]
  };
  let now = 100_000;
  let runIdIndex = 0;
  const catalog = new FileConversationCatalog({
    storageRootPath: path.join(root, "pi-native"),
    vaultId: `vault-${path.basename(root)}`,
    now: () => ++now
  });
  const productRuns = new FileProductRunStore({
    storageRootPath: path.join(root, "pi-native"),
    vaultId: catalog.vaultId,
    catalog,
    now: () => ++now
  });
  const runtime = new PiNativeConversationRuntime({
    catalog,
    productRuns,
    sessionApi: API,
    resolveConversationCwd: () => root,
    createAgentSession: async (input) => {
      currentMemoryTurnReader = input.currentMemoryTurnContext ?? null;
      currentKnowledgeTurnReader = input.currentKnowledgeTurnContext ?? null;
      currentMaintenanceCommandReader = input.currentMaintenanceCommand;
      currentSkillTurnReader = input.currentSkillTurnContext ?? null;
      currentDocumentTurnReader = input.currentDocumentTurnContext ?? null;
      currentToolExecutionReader = input.currentToolExecutionContext;
      currentSuccessfulExternalReadToolsReader =
        input.currentSuccessfulExternalReadToolNames;
      memoryRecallReporter = input.reportMemoryRecallProgress;
      askPersonalMemorySourcesReporter = input.reportAskPersonalMemorySources;
      if (nextActivationError) {
        const error = nextActivationError;
        nextActivationError = null;
        throw error;
      }
      const session = new ControlledAgentSession(
        input.sessionManager,
        factoryTools.registered,
        factoryTools.defaults,
        input.currentTaskPlanTurnContext,
        () => currentMemoryTurnReader?.() ?? null,
        () => currentKnowledgeTurnReader?.() ?? null,
        input.currentExecutionContext
      );
      sessions.push(session);
      return {
        session: session.asAgentSession(),
        planToolNames: [...factoryTools.planAllowed],
        externalReadToolNames: [...factoryTools.externalReadAllowed],
        memoryToolNames: [...memoryToolNames],
        ...(factoryWarnings.length ? { warnings: [...factoryWarnings] } : {}),
        ...(input.skillName
          ? {
              skillCommandName: input.skillName.includes(" ")
                ? "echoink-selected-skill"
                : input.skillName
          }
          : {}),
        ...(input.skillNames?.length
          ? {
              skillPromptPrefix: input.skillNames.map((name) =>
                `<skill name="${name}">fixture procedure</skill>`
              ).join("\n\n")
            }
          : {})
      };
    },
    idFactory: () => runIds[runIdIndex++] ?? `run-extra-${runIdIndex}`,
    now: () => ++now,
    ...runtimeOptions
  });
  await runtime.initialize();
  try {
    await assertion({
      root,
      catalog,
      productRuns,
      runtime,
      submit: (request) => runtime.submit({
        permission: "workspace-write",
        ...request,
        runtimeProviderId: request.runtimeProviderId ?? "fixture-provider",
        modelId: request.modelId ?? "fixture-model",
        reasoning: request.reasoning ?? "medium"
      }),
      sessions,
      failNextActivation: (error) => {
        nextActivationError = error;
      },
      setFactoryWarnings: (warnings) => {
        factoryWarnings = [...warnings];
      },
      setMemoryToolNames: (names) => {
        memoryToolNames = [...names];
      },
      configureFactoryTools: (input) => {
        factoryTools = {
          registered: [...input.registered],
          defaults: [...input.defaults],
          planAllowed: [...input.planAllowed],
          externalReadAllowed: [...(input.externalReadAllowed ?? [])]
        };
      },
      currentMemoryTurn: () => currentMemoryTurnReader?.() ?? null,
      currentKnowledgeTurn: () => currentKnowledgeTurnReader?.() ?? null,
      currentMaintenanceCommand: async () => {
        assert.ok(currentMaintenanceCommandReader);
        return await currentMaintenanceCommandReader();
      },
      currentSkillTurn: () => currentSkillTurnReader?.() ?? null,
      currentDocumentTurn: () => currentDocumentTurnReader?.() ?? null,
      currentToolExecution: () => {
        assert.ok(currentToolExecutionReader);
        return currentToolExecutionReader();
      },
      currentSuccessfulExternalReadTools: () =>
        currentSuccessfulExternalReadToolsReader?.() ?? [],
      reportMemoryRecall: async (input) => {
        assert.ok(memoryRecallReporter);
        await memoryRecallReporter(input);
      },
      reportAskPersonalMemorySources: async (input) => {
        assert.ok(askPersonalMemorySourcesReporter);
        await askPersonalMemorySourcesReporter(input);
      },
      latestSession: () => {
        const session = sessions.at(-1);
        assert.ok(session, "expected an activated AgentSession fixture");
        return session;
      }
    });
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledAgentSession {
  readonly promptTexts: string[] = [];
  readonly promptImages: ImageContent[][] = [];
  readonly model: Model<Api> = {
    id: "fixture-model",
    name: "Fixture Model",
    api: "openai-completions",
    provider: "fixture-provider",
    baseUrl: "https://fixture.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128_000,
    maxTokens: 32_000,
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max"
    }
  };
  readonly thinkingLevelChanges: ModelThinkingLevel[] = [];
  readonly taskPlanTurns: Array<Readonly<PiNativeTaskPlanTurnContext> | null> = [];
  readonly lifecycleCalls: string[] = [];
  readonly activeToolSelections: string[][] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly memoryTurnsBeforeUserEntryAppend: Array<Readonly<PiNativeMemoryTurnContext> | null> = [];
  readonly knowledgeTurnsBeforeUserEntryAppend: Array<Readonly<PiNativeKnowledgeTurnContext> | null> = [];
  readonly settingsManager = {
    flush: async (): Promise<void> => {
      this.lifecycleCalls.push("flush");
    }
  };
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private promptSequence = 0;
  private toolSequence = 0;
  private providerReasoningSequence = 0;
  private resolvePrompt: (() => void) | null = null;
  private rejectPrompt: ((error: unknown) => void) | null = null;
  private idlePromise: Promise<void> = Promise.resolve();
  private nextPromptError: Error | null = null;
  private corruptJsonlAfterNextUserEntry = false;
  private runtimeMessageTimestampDrift = false;
  private emitSettledOnAbort = true;
  isStreaming = false;
  disposed = false;

  private activeToolNames: string[];

  constructor(
    readonly sessionManager: SessionManager,
    private readonly registeredToolNames: readonly string[] = [],
    defaultToolNames: readonly string[] = [],
    private readonly currentTaskPlanTurn: () =>
      Readonly<PiNativeTaskPlanTurnContext> | null = () => null,
    private readonly currentMemoryTurn: () =>
      Readonly<PiNativeMemoryTurnContext> | null = () => null,
    private readonly currentKnowledgeTurn: () =>
      Readonly<PiNativeKnowledgeTurnContext> | null = () => null,
    private readonly currentProviderExecution: () => unknown = () => null
  ) {
    this.activeToolNames = [...defaultToolNames];
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  get messages(): AgentMessage[] {
    return this.sessionManager.getEntries().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : []
    );
  }

  asAgentSession(): AgentSession {
    return this as unknown as AgentSession;
  }

  failNextPrompt(error: Error): void {
    this.nextPromptError = error;
  }

  corruptSessionJsonlAfterNextUserEntry(): void {
    this.corruptJsonlAfterNextUserEntry = true;
  }

  enableRuntimeMessageTimestampDrift(): void {
    this.runtimeMessageTimestampDrift = true;
  }

  omitAgentSettledOnAbort(): void {
    this.emitSettledOnAbort = false;
  }

  prompt(
    text: string,
    options: { source?: string; images?: ImageContent[] }
  ): Promise<void> {
    assert.equal(options.source, "interactive");
    assert.equal(this.isStreaming, false);
    this.promptTexts.push(text);
    this.promptImages.push(
      (options.images ?? []).map((image) => ({ ...image }))
    );
    this.taskPlanTurns.push(this.currentTaskPlanTurn());
    this.memoryTurnsBeforeUserEntryAppend.push(this.currentMemoryTurn());
    this.knowledgeTurnsBeforeUserEntryAppend.push(
      this.currentKnowledgeTurn()
    );
    if (this.nextPromptError) {
      const error = this.nextPromptError;
      this.nextPromptError = null;
      throw error;
    }
    this.promptSequence += 1;
    const userMessage: UserMessage = {
      role: "user",
      content: options.images?.length
        ? [
            { type: "text", text },
            ...options.images.map((image) => ({ ...image }))
          ]
        : text,
      timestamp: 200_000 + this.promptSequence
    };
    this.sessionManager.appendMessage(userMessage);
    if (this.corruptJsonlAfterNextUserEntry) {
      const sessionFile = this.sessionManager.getSessionFile();
      assert.ok(sessionFile, "expected a persistent test Session JSONL");
      this.corruptJsonlAfterNextUserEntry = false;
      appendFileSync(sessionFile, "not-json\n", "utf8");
    }
    if (this.runtimeMessageTimestampDrift) {
      const runtimeUserMessage = {
        ...userMessage,
        timestamp: userMessage.timestamp + 10_000
      };
      this.emit({ type: "message_start", message: runtimeUserMessage });
      this.emit({ type: "message_end", message: runtimeUserMessage });
    }
    this.isStreaming = true;
    const prompt = new Promise<void>((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
    });
    this.idlePromise = prompt.catch(() => undefined);
    return prompt;
  }

  finishSuccessful(text: string): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    const durableAssistantMessage = assistantMessage(
      text,
      300_000 + this.promptSequence
    );
    this.sessionManager.appendMessage(durableAssistantMessage);
    if (this.runtimeMessageTimestampDrift) {
      const runtimeAssistantMessage = {
        ...durableAssistantMessage,
        timestamp: durableAssistantMessage.timestamp + 10_000
      };
      this.emit({ type: "message_start", message: runtimeAssistantMessage });
      this.emit({ type: "message_end", message: runtimeAssistantMessage });
    }
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  finishFailed(errorMessage: string, text = ""): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    this.sessionManager.appendMessage({
      ...assistantMessage(text, 300_000 + this.promptSequence),
      stopReason: "error",
      errorMessage
    });
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  finishAborted(): void {
    const resolve = this.resolvePrompt;
    assert.ok(resolve, "expected a pending prompt");
    this.sessionManager.appendMessage({
      ...assistantMessage("", 300_000 + this.promptSequence),
      stopReason: "aborted"
    });
    this.emit({ type: "agent_settled" });
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    resolve();
  }

  emitAssistantText(delta: string): void {
    const message = assistantMessage(
      delta,
      300_000 + this.promptSequence
    );
    this.emit({ type: "message_start", message });
    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta,
        contentIndex: 0
      }
    } as AgentSessionEvent);
  }

  emitProviderReasoning(text: string): void {
    this.providerReasoningSequence += 1;
    this.emitProviderReasoningBlocks(
      [text],
      300_000 + this.promptSequence + this.providerReasoningSequence
    );
  }

  emitProviderReasoningBlocks(
    texts: readonly string[],
    timestamp: number,
    beforeEvent: (
      index: number,
      phase: "start" | "delta" | "end"
    ) => void = () => undefined
  ): void {
    const message: AssistantMessage = {
      ...assistantMessage("", timestamp),
      content: texts.map((thinking) => ({ type: "thinking" as const, thinking }))
    };
    this.emit({ type: "message_start", message });
    texts.forEach((text, contentIndex) => {
      beforeEvent(contentIndex, "start");
      this.emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex,
          partial: message
        }
      } as AgentSessionEvent);
      beforeEvent(contentIndex, "delta");
      this.emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex,
          delta: text,
          partial: message
        }
      } as AgentSessionEvent);
      beforeEvent(contentIndex, "end");
      this.emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex,
          content: text,
          partial: message
        }
      } as AgentSessionEvent);
    });
  }

  beginProviderRequest(): void {
    this.currentProviderExecution();
  }

  emitToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args
    });
  }

  emitToolEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean
  ): void {
    this.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result,
      isError
    });
  }

  finishTool(
    toolCallId: string,
    toolName: string,
    result: Readonly<Record<string, unknown>>,
    isError: boolean
  ): void {
    this.startTool(toolCallId, toolName, {});
    this.finishToolResult(toolCallId, toolName, result, isError);
  }

  finishToolResult(
    toolCallId: string,
    toolName: string,
    result: Readonly<Record<string, unknown>>,
    isError: boolean
  ): void {
    this.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName,
      content: Array.isArray(result.content) ? result.content as Array<{ type: "text"; text: string }> : [{ type: "text", text: isError ? "failed" : "completed" }],
      details: result.details,
      isError,
      timestamp: 250_000 + this.toolSequence
    });
    this.emitToolEnd(toolCallId, toolName, result, isError);
  }

  startTool(toolCallId: string, toolName: string, args: unknown): void {
    this.emitToolStart(toolCallId, toolName, args);
    this.toolSequence += 1;
    this.sessionManager.appendMessage({
      ...assistantMessage("", 240_000 + this.toolSequence),
      content: [{
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: {}
      }],
      stopReason: "toolUse"
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.lifecycleCalls.push("unsubscribe");
      this.listeners.delete(listener);
    };
  }

  getActiveToolNames(): string[] {
    return [...this.activeToolNames];
  }

  getAllTools(): Array<{ name: string }> {
    return this.registeredToolNames.map((name) => ({ name }));
  }

  setActiveToolsByName(names: readonly string[]): void {
    assert.equal(
      names.every((name) => this.registeredToolNames.includes(name)),
      true
    );
    this.activeToolNames = [...names];
    this.activeToolSelections.push([...names]);
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.thinkingLevelChanges.push(level);
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.lifecycleCalls.push("clearQueue");
    const cleared = {
      steering: [...this.steering],
      followUp: [...this.followUps]
    };
    this.steering.length = 0;
    this.followUps.length = 0;
    return cleared;
  }

  abortCompaction(): void {}

  async abort(): Promise<void> {
    this.lifecycleCalls.push("abort");
    const reject = this.rejectPrompt;
    if (reject && this.emitSettledOnAbort) {
      this.emit({ type: "agent_settled" });
    }
    this.isStreaming = false;
    this.resolvePrompt = null;
    this.rejectPrompt = null;
    reject?.(new Error("fixture prompt aborted"));
  }

  async waitForIdle(): Promise<void> {
    this.lifecycleCalls.push("waitForIdle");
    await this.idlePromise;
  }

  dispose(): void {
    this.lifecycleCalls.push("dispose");
    this.disposed = true;
    this.listeners.clear();
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, 1_000);
  });
  try {
    return await Promise.race([promise, timeoutFailure]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForTestCondition(
  predicate: () => boolean | Promise<boolean>
): Promise<void> {
  await withTimeout((async () => {
    while (!await predicate()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  })(), "test condition");
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "stop",
    timestamp
  };
  return message;
}

function preparedImage(
  name: string,
  localPath: string,
  mimeType: "image/png" | "image/jpeg",
  data: string
): Readonly<PiChatPreparedImage> {
  return Object.freeze({
    content: Object.freeze({
      kind: "inline_image" as const,
      preflight: "approved" as const,
      data,
      mimeType
    }),
    attachment: Object.freeze({
      type: "image" as const,
      name,
      path: localPath,
      mimeType
    })
  });
}

async function assertWorkspacePermissionsAndLateSources(): Promise<void> {
  const reads = ["vault_search", "note_read", "knowledge_search", "knowledge_read", "memory_search", "memory_read", "external_read"];
  const writes = ["note_create", "note_update", "memory_write", "knowledge_maintain", "external_write"];
  const defaults = [...reads, ...writes];
  for (const permission of ["read-only", "workspace-write", "danger-full-access"] as const) {
    for (const commandKind of ["chat", "ask", "maintain"] as const) {
      assert.deepEqual(new Set(resolveWorkspaceTools({ permission, commandKind, mode: "agent", memoryMode: "normal", defaultToolNames: defaults, memoryToolNames: ["memory_search", "memory_read", "memory_write"], planToolNames: ["note_read"], externalReadToolNames: ["external_read"] })), new Set(permission === "read-only" ? reads : defaults));
    }
  }
  assert.equal(resolveWorkspaceTools({ permission: "workspace-write", commandKind: "ask", mode: "agent", memoryMode: "no_memory", defaultToolNames: ["note_read"], memoryToolNames: [], planToolNames: [], externalReadToolNames: [] }).includes("external_read"), false);
  const reference = { referenceId: `knowledge-reference:${"b".repeat(64)}`, vaultRelativePath: "wiki/later.md", title: "Later source", excerpt: "real later read", contentRevision: `sha256:${"c".repeat(64)}`, lineStart: 1, lineEnd: 1 };
  const usages: any[] = [];
  const maintenanceRequests: string[] = [];
  let finalized = 0;
  const knowledge: PiKnowledgeRuntimePort = {
    async retrieveAsk() { return { status: "no_evidence", references: [], providerResourceText: "initial empty", retrieval: { elapsedMs: 1, total: 0, returned: 0, remaining: 0, hasMore: false, exhausted: true } }; },
    async verifyAskReferences(input) { return { status: "valid", references: input.references }; },
    async recordUsage(input) { usages.push(input.event); },
    async prepareMaintenancePreferences() { return { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}`, providerResourceText: "preferences" }; },
    async resolveMaintenanceScope(request) { maintenanceRequests.push(request); return QUERY_MAINTENANCE_SCOPE; },
    async finalizeMaintenance() { finalized += 1; }
  };
  await withFixture([], async (fixture) => {
    fixture.configureFactoryTools({ registered: defaults, defaults, planAllowed: ["note_read"], externalReadAllowed: ["external_read"] });
    fixture.setMemoryToolNames(["memory_search", "memory_read", "memory_write"]);
    for (const permission of ["read-only", "workspace-write", "danger-full-access"] as const) {
      const request = { conversationId: "permission-snapshot", text: "/ask read then answer", submittedAt: 1, permission, runtimeProviderId: "fixture-provider", modelId: "fixture-model", reasoning: "medium" as const };
      const submission = fixture.runtime.submit(request);
      request.permission = permission === "read-only" ? "danger-full-access" : "read-only";
      const run = await submission;
      const session = fixture.latestSession();
      assert.equal(session.getActiveToolNames().includes("note_create"), permission !== "read-only");
      if (permission === "workspace-write") {
        const command = await fixture.currentMaintenanceCommand();
        assert.equal(command.request, "read then answer");
        assert.deepEqual(command.scope, QUERY_MAINTENANCE_SCOPE);
        assert.deepEqual(maintenanceRequests, ["read then answer"], "writable ask lazily resolves the existing maintenance scope");
        session.finishTool("late-read", "knowledge_read", { details: { type: "echoink.knowledge-references.v1", schemaVersion: 1, references: [reference], status: "completed" } }, false);
      }
      session.finishSuccessful(permission === "workspace-write" ? "answer with later evidence" : "no local evidence");
      assert.equal((await run.result).permission, permission);
      assert.equal((await fixture.productRuns.read(run.productRunId))?.permission, permission);
    }
    assert.deepEqual(usages.map((event) => event.referenceIds), [[], [reference.referenceId], []]);
    const readonlyMaintain = await fixture.submit({ conversationId: "permission-maintain", permission: "read-only", text: "/maintain 先分析", submittedAt: 4 });
    assert.ok(fixture.currentMemoryTurn(), "maintain does not disable enabled Memory");
    assert.equal(fixture.latestSession().getActiveToolNames().includes("knowledge_maintain"), false);
    fixture.latestSession().finishSuccessful("只读下提供维护建议。");
    assert.equal((await readonlyMaintain.result).terminalState, "completed");
    assert.equal(finalized, 0, "read-only maintenance does not finalize any content writes");
  }, { knowledge });
}

export async function runWikiStructurePreflightTests(): Promise<void> {
  let prepared = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let block = false;
  const knowledge: PiKnowledgeRuntimePort = {
    async prepareMaintenanceStructure(input) {
      prepared++;
      if (block) { entered?.(); await new Promise<void>((resolve) => { release = resolve; }); }
      input.assertActive();
      return "DIRECTORY_LAYOUT_READY";
    },
    async prepareMaintenancePreferences() { return { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}`, providerResourceText: "preferences" }; },
    async retrieveAsk() { throw new Error("not used"); },
    async verifyAskReferences() { return { status: "valid", references: [] }; }
  };
  await withFixture([], async (fixture) => {
    fixture.configureFactoryTools({ registered: ["note_read", "knowledge_maintain"], defaults: ["note_read", "knowledge_maintain"], planAllowed: ["note_read"] });
    for (const [id, text, permission] of [["read", "/maintain", "read-only"], ["advice", "/maintain 先不要写入", "workspace-write"]] as const) {
      const handle = await fixture.submit({ conversationId: id, text, permission, submittedAt: 1 });
      assert.equal(prepared, 0, "read-only and advice-only must not invoke structural preflight");
      fixture.latestSession().finishSuccessful("建议");
      assert.equal((await handle.result).terminalState, "completed");
    }
    const writable = await fixture.submit({ conversationId: "write", text: "/maintain", maintenanceScope: { mode: "global" }, permission: "workspace-write", submittedAt: 2 });
    assert.equal(prepared, 1);
    const turn = fixture.latestSession().knowledgeTurnsBeforeUserEntryAppend.at(-1);
    assert.equal(turn?.kind, "maintain");
    if (turn?.kind === "maintain") assert.match(turn.command.preference.providerResourceText, /DIRECTORY_LAYOUT_READY/u);
    fixture.latestSession().finishSuccessful("No tool result in this fixture");
    await writable.result;
    block = true;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const submitting = fixture.submit({ conversationId: "cancel-before-name", text: "/maintain", maintenanceScope: { mode: "global" }, permission: "workspace-write", submittedAt: 3 });
    const rejection = assert.rejects(submitting, /维护已取消/u);
    await started;
    await fixture.runtime.abort("cancel-before-name");
    release?.();
    await rejection;
  }, { knowledge });
  console.log("Production runtime structural preflight order, read-only, advice and cancellation: PASS");
}
