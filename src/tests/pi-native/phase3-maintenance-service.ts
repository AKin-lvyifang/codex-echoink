import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  PHASE3_MAINTENANCE_RAW_INDEX_PATH,
  PHASE3_MAINTENANCE_TRACKER_PATH,
  Phase3KnowledgeMaintenanceService,
  Phase3MaintenanceError,
  Phase3MaintenanceSimulatedReload,
  phase3MaintenanceReportPath,
  type Phase3MaintenanceConfirmToolCallContext,
  type Phase3MaintenanceImmutableFileBinding,
  type Phase3MaintenanceProposal,
  type Phase3MaintenanceProposalInput,
  type Phase3MaintenanceProposalPort,
  type Phase3MaintenanceSourceBinding,
  type Phase3MaintenanceSourceSnapshotPort,
  type Phase3MaintenanceStateStore,
  type Phase3MaintenanceStoredPreview,
  type Phase3MaintenanceTargetBinding,
  type Phase3MaintenanceTrackerPort,
  type Phase3MaintenanceTrackerSnapshot,
  type Phase3MaintenanceWalRecord
} from "../../knowledge-base/phase3-maintenance-service";
import type {
  VaultOperationResult,
  VaultReadbackState
} from "../../harness/pi-native/vault-domain-service";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_VERSION,
  echoInkKnowledgeMaintenanceProtocolPrompt
} from "../../knowledge-base/knowledge-maintenance-protocol";
import {
  KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA,
  createKnowledgeMaintenanceResultEnvelope,
  knowledgeMaintenanceReportPayloadFromToolResult,
  parseKnowledgeMaintenanceResultEnvelope
} from "../../knowledge-base/knowledge-maintenance-result";
import {
  createPiKnowledgeMaintenanceToolSecurity
} from "../../harness/pi-native/pi-knowledge-maintenance-tool";
import {
  ProductionPiKnowledgeMaintenanceToolPort
} from "../../plugin/pi-knowledge-maintenance-production";

const VAULT_ID = "phase3-fixture-vault";
const DATE_KEY = "2026-08-03";
const PREFERENCE = Object.freeze({
  profileVersion: "echoink-knowledge-preference-profile-v1",
  state: "default" as const,
  revision: `sha256:${"a".repeat(64)}`
});

/**
 * Pure P3-3 checks. This suite creates no Vault or secondary fixture root, so
 * the aggregate Phase 3 runner can call it while retaining its one Manifest
 * fixture as the only filesystem acceptance Vault.
 */
export async function runPhase3KnowledgeMaintenanceServiceTests(): Promise<void> {
  assertProtocolRequiresStructuredNoop();
  assertStrictDurableResultEnvelope();
  await assertMaintenanceScopeSecurityIsFailClosed();
  await assertReliableExistingKnowledgeReturnsNoopBeforeWrites();
  await assertProductionStructuredNoopCompletesChangedRaw();
  await assertStructuredNoopProcessesExplicitRaw();
  await assertExplicitRawPriorityAndDirectSequentialWrite();
  await assertDirectRunCreatesNoActivePreviewOrApproval();
  await assertTrackerSelectionStopsAtTwenty();
  await assertKnowledgeCandidatesRequireExactRawSources();
  await assertWhitelistAndBatchCasConflictWriteNothing();
  await assertAgentExpectedExistingTargetRejectsConcurrentEdit();
  await assertAgentExpectedMissingTargetRejectsConcurrentCreate();
  await assertAgentExpectedExistingTargetAllowsUnchangedUpdate();
  await assertCandidateActionExpectedTargetIsStrict();
  await assertWalRecoveryDoesNotRegenerateOrRepeatWrite();
  await assertTruncatedLargeKnowledgeReadbackStillProducesNote();
  await assertBlockedWalRejectsNextMaintenance();
  await assertCompletedCheckpointFailureIsWriteUncertainAndRecoveredFirst();
  await assertRecoveredWalRejectsCandidatesBuiltBeforeRecovery();
}

function assertProtocolRequiresStructuredNoop(): void {
  const prompt = echoInkKnowledgeMaintenanceProtocolPrompt();
  assert.match(
    prompt,
    /无需更新时传入 candidateActions: \[\]，由工具返回 noop/u
  );
  assert.match(prompt, /不得只用普通 Assistant 文本结束维护/u);
}

async function assertMaintenanceScopeSecurityIsFailClosed(): Promise<void> {
  const authorize = async (input: Readonly<{
    name: string;
    request: string;
    scope: Readonly<
      | { mode: "global" }
      | { mode: "exact"; sourcePaths: readonly [string] }
      | { mode: "batch"; sourcePaths: readonly string[] }
      | { mode: "query"; candidatePaths: readonly string[] }
    >;
    arguments: Readonly<Record<string, unknown>>;
    successfulExternalRead?: boolean;
  }>) => {
    const security = createPiKnowledgeMaintenanceToolSecurity({
      currentRunIdentity: () => Object.freeze({
        vaultId: VAULT_ID,
        conversationId: `conversation-${input.name}`,
        piSessionId: `pi-${input.name}`,
        productRunId: `run-${input.name}`
      }),
      currentCommand: () => Object.freeze({
        mode: "maintain" as const,
        request: input.request,
        scope: input.scope,
        preference: Object.freeze({
          ...PREFERENCE,
          providerResourceText: "PREFERENCE_FIXTURE"
        })
      }),
      hasSuccessfulExternalRead: () =>
        input.successfulExternalRead === true,
      egress: { assertAllowed: () => undefined }
    });
    const toolCallId = `tool-${input.name}`;
    const blocked = await security.handleToolCall({
      toolName: "knowledge_maintain",
      toolCallId,
      input: input.arguments
    } as never, undefined);
    return { security, toolCallId, blocked };
  };

  const global = await authorize({
    name: "global",
    request: "",
    scope: { mode: "global" },
    arguments: {
      candidateActions: [],
      assessments: [{
        claim: "当前版本仍受支持",
        status: "valid",
        evidence: ["https://example.test/current"],
        asOf: "2026-08-30",
        verification: "external_verified"
      }]
    }
  });
  assert.equal(global.blocked, undefined);
  const globalConsumed = global.security.consume(global.toolCallId, {
    candidateActions: [],
    assessments: [{
      claim: "当前版本仍受支持",
      status: "valid",
      evidence: ["https://example.test/current"],
      asOf: "2026-08-30",
      verification: "external_verified"
    }]
  });
  assert.deepEqual(globalConsumed.sourcePaths, []);
  assert.equal(globalConsumed.assessments[0]?.status, "valid");
  assert.equal(globalConsumed.assessments[0]?.verification, "unverified",
    "without an external Tool result the model cannot self-report external verification");

  const failedExternal = await authorize({
    name: "failed-external-read",
    request: "",
    scope: { mode: "global" },
    successfulExternalRead: false,
    arguments: {
      candidateActions: [],
      assessments: [{
        claim: "外部工具调用失败后仍声称核验",
        status: "needs_supplement",
        evidence: ["failed external read"],
        asOf: "2026-08-30",
        verification: "external_verified"
      }]
    }
  });
  assert.equal(failedExternal.blocked, undefined);
  assert.equal(failedExternal.security.consume(
    failedExternal.toolCallId,
    {
      candidateActions: [],
      assessments: [{
        claim: "外部工具调用失败后仍声称核验",
        status: "needs_supplement",
        evidence: ["failed external read"],
        asOf: "2026-08-30",
        verification: "external_verified"
      }]
    }
  ).assessments[0]?.verification, "unverified");

  const successfulExternal = await authorize({
    name: "successful-external-read",
    request: "",
    scope: { mode: "global" },
    successfulExternalRead: true,
    arguments: {
      candidateActions: [],
      assessments: [{
        claim: "同轮成功读取的外部证据",
        status: "valid",
        evidence: ["successful external read"],
        asOf: "2026-08-30",
        verification: "external_verified"
      }]
    }
  });
  assert.equal(successfulExternal.blocked, undefined);
  assert.equal(successfulExternal.security.consume(
    successfulExternal.toolCallId,
    {
      candidateActions: [],
      assessments: [{
        claim: "同轮成功读取的外部证据",
        status: "valid",
        evidence: ["successful external read"],
        asOf: "2026-08-30",
        verification: "external_verified"
      }]
    }
  ).assessments[0]?.verification, "external_verified");
  assert.deepEqual((await authorize({
    name: "global-forged-source",
    request: "",
    scope: { mode: "global" },
    arguments: { candidateActions: [], sourcePaths: ["raw/a.md"] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });

  const batchPaths = ["raw/a.md", "raw/b.markdown"];
  const batch = await authorize({
    name: "batch",
    request: "",
    scope: { mode: "batch", sourcePaths: batchPaths },
    arguments: { candidateActions: [], sourcePaths: batchPaths }
  });
  assert.equal(batch.blocked, undefined);
  assert.deepEqual(
    batch.security.consume(batch.toolCallId, {
      candidateActions: [],
      sourcePaths: batchPaths
    }).sourcePaths,
    batchPaths
  );
  assert.deepEqual((await authorize({
    name: "batch-reordered",
    request: "",
    scope: { mode: "batch", sourcePaths: batchPaths },
    arguments: { candidateActions: [], sourcePaths: [...batchPaths].reverse() }
  })).blocked, { block: true, reason: "tool_policy_blocked" });
  assert.deepEqual((await authorize({
    name: "batch-outside",
    request: "",
    scope: { mode: "batch", sourcePaths: batchPaths },
    arguments: { candidateActions: [], sourcePaths: ["raw/a.md", "raw/c.md"] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });
  assert.deepEqual((await authorize({
    name: "batch-empty",
    request: "",
    scope: { mode: "batch", sourcePaths: [] },
    arguments: { candidateActions: [], sourcePaths: [] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });
  assert.deepEqual((await authorize({
    name: "batch-duplicate",
    request: "",
    scope: { mode: "batch", sourcePaths: ["raw/a.md", "raw/a.md"] },
    arguments: { candidateActions: [], sourcePaths: ["raw/a.md", "raw/a.md"] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });
  const oversizedBatch = Array.from(
    { length: 21 },
    (_, index) => `raw/oversized-${index}.md`
  );
  assert.deepEqual((await authorize({
    name: "batch-oversized",
    request: "",
    scope: { mode: "batch", sourcePaths: oversizedBatch },
    arguments: { candidateActions: [], sourcePaths: oversizedBatch }
  })).blocked, { block: true, reason: "tool_policy_blocked" });
  assert.deepEqual((await authorize({
    name: "global-empty-source-field",
    request: "",
    scope: { mode: "global" },
    arguments: { candidateActions: [], sourcePaths: [] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });

  const exact = await authorize({
    name: "exact",
    request: "",
    scope: { mode: "exact", sourcePaths: ["raw/a.md"] },
    arguments: { candidateActions: [] }
  });
  assert.equal(exact.blocked, undefined);
  assert.deepEqual(
    exact.security.consume(exact.toolCallId, { candidateActions: [] })
      .sourcePaths,
    ["raw/a.md"]
  );
  assert.deepEqual((await authorize({
    name: "exact-wrong-source",
    request: "",
    scope: { mode: "exact", sourcePaths: ["raw/a.md"] },
    arguments: { candidateActions: [], sourcePaths: ["raw/b.md"] }
  })).blocked, { block: true, reason: "tool_policy_blocked" });

  const query = await authorize({
    name: "query",
    request: "目标笔记",
    scope: {
      mode: "query",
      candidatePaths: ["raw/a.md", "raw/b.md"]
    },
    arguments: { candidateActions: [], sourcePaths: ["raw/b.md"] }
  });
  assert.equal(query.blocked, undefined);
  assert.deepEqual(
    query.security.consume(query.toolCallId, {
      candidateActions: [],
      sourcePaths: ["raw/b.md"]
    }).sourcePaths,
    ["raw/b.md"]
  );
  for (const [name, sourcePaths] of [
    ["query-missing-source", undefined],
    ["query-outside-candidate", ["raw/c.md"]],
    ["query-multiple-sources", ["raw/a.md", "raw/b.md"]]
  ] as const) {
    assert.deepEqual((await authorize({
      name,
      request: "目标笔记",
      scope: {
        mode: "query",
        candidatePaths: ["raw/a.md", "raw/b.md"]
      },
      arguments: {
        candidateActions: [],
        ...(sourcePaths ? { sourcePaths } : {})
      }
    })).blocked, { block: true, reason: "tool_policy_blocked" }, name);
  }

  const actionWithoutAssessment = await authorize({
    name: "write-without-assessment",
    request: "",
    scope: { mode: "global" },
    arguments: {
      candidateActions: [{
        targetPath: "wiki/missing-assessment.md",
        content: "candidate",
        expectedTarget: { kind: "missing" }
      }]
    }
  });
  assert.deepEqual(actionWithoutAssessment.blocked, {
    block: true,
    reason: "tool_policy_blocked"
  });

  for (const [index, status] of [
    "valid",
    "needs_supplement",
    "outdated",
    "conflict"
  ].entries()) {
    const argumentsValue = {
      candidateActions: [{
        targetPath: `wiki/assessment-${status}.md`,
        content: `candidate ${status}`,
        expectedTarget: { kind: "missing" }
      }],
      assessments: [{
        claim: `claim ${status}`,
        status,
        evidence: ["raw/a.md"],
        asOf: "2026-08-30",
        verification: "unverified"
      }]
    };
    const authorized = await authorize({
      name: `assessment-${index}`,
      request: "",
      scope: { mode: "global" },
      arguments: argumentsValue
    });
    assert.equal(authorized.blocked, undefined);
    assert.equal(
      authorized.security.consume(authorized.toolCallId, argumentsValue)
        .assessments[0]?.status,
      status
    );
  }
}

async function assertReliableExistingKnowledgeReturnsNoopBeforeWrites(): Promise<void> {
  let indexCalls = 0;
  const domain = new Proxy({}, {
    get() {
      throw new Error("reliable noop must not access the Vault write domain");
    }
  });
  const port = new ProductionPiKnowledgeMaintenanceToolPort({
    vaultRootPath: ".tmp/echoink-reliable-noop-vault-not-used",
    privateKnowledgeRootPath:
      ".tmp/echoink-reliable-noop-state-not-used",
    vaultId: VAULT_ID,
    userId: "user-phase3",
    deviceId: "device-phase3",
    domainService: domain as never,
    knowledgeAgentIndex: {
      async readReliableKnowledgeForRaw(rawPath) {
        indexCalls += 1;
        assert.equal(rawPath, "raw/a.md");
        return Object.freeze({
          rawPath,
          rawContentRevision: `sha256:${"a".repeat(64)}`,
          entries: Object.freeze([Object.freeze({
            vaultRelativePath: "wiki/existing.md",
            title: "现有知识",
            content: "现有且已回读的知识正文"
          })])
        });
      }
    }
  });
  const result = await port.execute({
    vaultId: VAULT_ID,
    conversationId: "conversation-reliable-noop",
    piSessionId: "pi-reliable-noop",
    productRunId: "run-reliable-noop",
    toolCallId: "tool-reliable-noop",
    mode: "maintain",
    request: "目标笔记",
    sourcePaths: ["raw/a.md"],
    preferenceSnapshot: PREFERENCE,
    candidateActions: [{
      targetPath: "wiki/should-not-write.md",
      content: "不得写入",
      expectedTarget: { kind: "missing" }
    }],
    assessments: [{
      claim: "现有知识仍与当前 Raw 一致",
      status: "valid",
      evidence: ["raw/a.md", "wiki/existing.md"],
      asOf: "2026-08-30",
      verification: "local_verified"
    }]
  });
  assert.equal(indexCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.maintenanceResult?.status, "noop");
  assert.equal(result.maintenanceResult?.assessments[0]?.status, "valid");
  assert.deepEqual(result.producedPaths, []);
  assert.match(result.message, /现有知识/u);
  assert.match(result.message, /wiki\/existing\.md/u);
}

async function assertProductionStructuredNoopCompletesChangedRaw(): Promise<void> {
  const fixtureRoot = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-maintain-noop-"))
  );
  const vaultRootPath = path.join(fixtureRoot, "vault");
  const privateKnowledgeRootPath = path.join(fixtureRoot, "private");
  const rawPath = "raw/a.md";
  const rawContent = "没有可提炼的测试内容";
  const trackerContent = "# Knowledge Maintenance Tracker\n";
  const domain = new FakeVaultDomain();
  try {
    await fsp.mkdir(path.join(vaultRootPath, "raw"), { recursive: true });
    await fsp.mkdir(path.join(vaultRootPath, "outputs"), { recursive: true });
    await fsp.mkdir(privateKnowledgeRootPath, { recursive: true, mode: 0o700 });
    await fsp.chmod(privateKnowledgeRootPath, 0o700);
    await fsp.writeFile(path.join(vaultRootPath, rawPath), rawContent);
    await fsp.writeFile(
      path.join(vaultRootPath, PHASE3_MAINTENANCE_TRACKER_PATH),
      trackerContent
    );
    domain.seed(rawPath, rawContent);
    domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, trackerContent);

    const port = new ProductionPiKnowledgeMaintenanceToolPort({
      vaultRootPath,
      privateKnowledgeRootPath,
      vaultId: VAULT_ID,
      userId: "user-phase3",
      deviceId: "device-phase3",
      domainService: domain as never,
      dateKey: () => DATE_KEY
    });
    await port.initialize();
    const writesBeforeRejectedCandidate = domain.formalWrites.length;
    const rejectedCandidate = await port.execute({
      vaultId: VAULT_ID,
      conversationId: "conversation-production-missing-assessment",
      piSessionId: "pi-production-missing-assessment",
      productRunId: "run-production-missing-assessment",
      toolCallId: "tool-production-missing-assessment",
      mode: "maintain",
      request: "/maintain",
      sourcePaths: [rawPath],
      preferenceSnapshot: PREFERENCE,
      candidateActions: [{
        targetPath: "wiki/missing-assessment.md",
        content: "must not write",
        expectedTarget: { kind: "missing" }
      }]
    });
    assert.equal(rejectedCandidate.status, "failed");
    assert.equal(
      domain.formalWrites.length,
      writesBeforeRejectedCandidate,
      "candidateActions without assessments fail before any Vault write"
    );

    await fsp.mkdir(path.join(vaultRootPath, "wiki/人工智能（AI）"), { recursive: true });
    for (const [targetPath, reason] of [["wiki/english-only/note.md", "新 Wiki 分类"], ["wiki/另一名称（AI）/note.md", "复用已有 Wiki"]]) {
      const invalidFolder = await port.execute({
        vaultId: VAULT_ID, conversationId: "category-contract", piSessionId: "pi-category-contract",
        productRunId: `category-${reason}`, toolCallId: `category-${reason}`, mode: "maintain", request: "", sourcePaths: [rawPath], preferenceSnapshot: PREFERENCE,
        candidateActions: [{ targetPath, content: "not written", expectedTarget: {kind:"missing"} }],
        assessments: [{ claim: "fixture", status:"valid", evidence:[rawPath], asOf:DATE_KEY, verification:"unverified" }]
      });
      assert.equal(invalidFolder.status, "failed");
      assert.ok(invalidFolder.message.includes(reason), invalidFolder.message);
      assert.equal(domain.formalWrites.length, writesBeforeRejectedCandidate);
    }
    const result = await port.execute({
      vaultId: VAULT_ID,
      conversationId: "conversation-production-noop",
      piSessionId: "pi-production-noop",
      productRunId: "run-production-noop",
      toolCallId: "tool-production-noop",
      mode: "maintain",
      request: "/maintain",
      sourcePaths: [rawPath],
      preferenceSnapshot: PREFERENCE,
      candidateActions: []
    });

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.maintenanceResult?.status, "noop");
    assert.match(result.message, /没有可提炼内容/u);
    assert.deepEqual(result.maintenanceResult?.notes, []);
    assert.equal(
      result.maintenanceResult?.systemPaths.includes(
        PHASE3_MAINTENANCE_TRACKER_PATH
      ),
      true
    );
    assert.equal(domain.formalWrites.length, 3);
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function assertStructuredNoopProcessesExplicitRaw(): Promise<void> {
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => structuredNoopProposal(input)
  });
  fixture.domain.seed("raw/a.md", "没有可提炼的测试内容");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");

  const result = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    explicitRawPaths: ["raw/a.md"],
    preference: PREFERENCE,
    toolCall: toolCallFor("structured-noop")
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.notes, []);
  assert.deepEqual([...result.systemPaths].sort(), [
    PHASE3_MAINTENANCE_RAW_INDEX_PATH,
    PHASE3_MAINTENANCE_TRACKER_PATH,
    phase3MaintenanceReportPath(DATE_KEY)
  ].sort());
  assert.equal(fixture.domain.formalWrites.length, 3);
  assert.match(
    fixture.domain.content(PHASE3_MAINTENANCE_TRACKER_PATH) ?? "",
    /raw\/a\.md/u
  );
}

function assertStrictDurableResultEnvelope(): void {
  const envelope = createKnowledgeMaintenanceResultEnvelope({
    status: "completed",
    notes: [{
      operation: "created",
      path: "wiki/result.md",
      title: "最终标题",
      summary: "来自最终回读正文的摘要"
    }],
    systemPaths: [
      PHASE3_MAINTENANCE_RAW_INDEX_PATH,
      PHASE3_MAINTENANCE_TRACKER_PATH,
      phase3MaintenanceReportPath(DATE_KEY)
    ],
    assessments: ([
      "valid",
      "needs_supplement",
      "outdated",
      "conflict"
    ] as const).map((status) => ({
      claim: `claim ${status}`,
      status,
      evidence: ["raw/a.md"],
      asOf: "2026-08-30",
      verification: "unverified" as const
    }))
  });
  const payload = knowledgeMaintenanceReportPayloadFromToolResult({
    details: { maintenanceResult: envelope }
  });
  assert.equal(payload?.sections[0]?.count, 1);
  assert.equal(payload?.sections[0]?.items[0]?.path, "wiki/result.md");
  assert.equal(payload?.sections[0]?.items[0]?.description,
    "新建 · 来自最终回读正文的摘要");
  assert.deepEqual(
    parseKnowledgeMaintenanceResultEnvelope(envelope)?.assessments.map(
      (assessment) => assessment.status
    ),
    ["valid", "needs_supplement", "outdated", "conflict"],
    "all four maintenance assessment states survive the durable envelope"
  );
  assert.equal(payload?.sections.flatMap((section) => section.items)
    .some((item) => item.path === PHASE3_MAINTENANCE_RAW_INDEX_PATH), false);

  for (const forged of [
    {
      schema: KNOWLEDGE_MAINTENANCE_RESULT_SCHEMA,
      status: "completed",
      notes: [{
        operation: "created",
        path: PHASE3_MAINTENANCE_RAW_INDEX_PATH,
        title: "伪造成功",
        summary: "系统产物不能是知识笔记"
      }],
      issues: [],
      systemPaths: []
    },
    {
      ...envelope,
      unexpected: true
    },
    {
      ...envelope,
      notes: [{ ...envelope.notes[0], path: "../wiki/escape.md" }]
    }
  ]) {
    assert.equal(parseKnowledgeMaintenanceResultEnvelope(forged), null);
    assert.equal(knowledgeMaintenanceReportPayloadFromToolResult({
      details: { maintenanceResult: forged }
    }), null);
  }
}

async function assertExplicitRawPriorityAndDirectSequentialWrite(): Promise<void> {
  const fixture = createFixture({
    trackerPaths: ["raw/tracker-only.md", "raw/a.md"]
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed("raw/b.md", "raw b");
  fixture.domain.seed("raw/c.md", "raw c");
  fixture.domain.seed("raw/tracker-only.md", "tracker only");
  fixture.domain.seed("assets/a.bin", "attachment bytes");
  fixture.sources.attachments.set("raw/a.md", ["assets/a.bin"]);
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker before");

  const rawBefore = fixture.domain.digest("raw/a.md");
  const attachmentBefore = fixture.domain.digest("assets/a.bin");
  const committed = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    explicitRawPaths: [
      "raw/c.md",
      "raw/a.md",
      "raw/c.md",
      "raw/b.md"
    ],
    toolCall: toolCallFor("explicit")
  });
  assert.equal(committed.status, "completed");
  assert.equal(committed.readbackVerified, true);
  assert.equal("previewId" in committed, false);
  assert.deepEqual(committed.notes.map((note) => note.path), [
    "wiki/phase3-summary.md"
  ]);
  assert.equal(committed.notes[0]?.operation, "created");
  assert.match(committed.notes[0]?.summary ?? "", /knowledge from raw\/a\.md/u);
  assert.deepEqual(committed.systemPaths, [
    PHASE3_MAINTENANCE_RAW_INDEX_PATH,
    PHASE3_MAINTENANCE_TRACKER_PATH,
    phase3MaintenanceReportPath(DATE_KEY)
  ]);
  assert.deepEqual(fixture.domain.formalWrites, [
    "wiki/phase3-summary.md",
    PHASE3_MAINTENANCE_RAW_INDEX_PATH,
    PHASE3_MAINTENANCE_TRACKER_PATH,
    phase3MaintenanceReportPath(DATE_KEY)
  ]);
  assert.equal(fixture.proposal.calls, 1);
  assert.equal(fixture.approvals.issued, 0);
  assert.equal(fixture.approvals.confirmed, 0);
  assert.equal(fixture.approvals.consumed, 0);
  assert.equal(fixture.domain.digest("raw/a.md"), rawBefore);
  assert.equal(fixture.domain.digest("assets/a.bin"), attachmentBefore);
}

async function assertDirectRunCreatesNoActivePreviewOrApproval(): Promise<void> {
  const fixture = createFixture({ trackerPaths: ["raw/a.md"] });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  const result = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    toolCall: toolCallFor("direct")
  });
  assert.equal(result.status, "completed");
  assert.equal(await fixture.state.loadPreview("preview-1"), null);
  assert.equal(fixture.approvals.issued, 0);
  assert.equal(fixture.approvals.confirmed, 0);
  assert.equal(fixture.approvals.consumed, 0);
}

async function assertTrackerSelectionStopsAtTwenty(): Promise<void> {
  const paths = Array.from({ length: 21 }, (_, index) =>
    `raw/batch/${String(index + 1).padStart(3, "0")}.md`
  );
  const fixture = createFixture({ trackerPaths: [...paths].reverse() });
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker batch");
  for (const path of paths) fixture.domain.seed(path, `source ${path}`);

  const result = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    toolCall: toolCallFor("tracker-limit")
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(
    fixture.proposal.lastInput?.selectedSources.map(
      (source) => source.raw.relativePath
    ),
    paths.slice(0, 20)
  );
  assert.deepEqual(fixture.proposal.lastInput?.remainingRawPaths, [paths[20]]);
  assert.match(
    fixture.domain.content(phase3MaintenanceReportPath(DATE_KEY)) ?? "",
    new RegExp(paths[20]!.replaceAll("/", "\\/"), "u")
  );
  assert.equal(fixture.proposal.calls, 1);
}

async function assertWhitelistAndBatchCasConflictWriteNothing(): Promise<void> {
  const denied = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => defaultProposal(input, [{
      targetPath: "outputs/not-allowed.md",
      content: "forbidden"
    }])
  });
  denied.domain.seed("raw/a.md", "raw a");
  denied.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  await assert.rejects(
    denied.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("whitelist")
    }),
    phase3Error("proposal_invalid")
  );
  assert.equal(denied.domain.formalWrites.length, 0);

  const conflict = createFixture({ trackerPaths: ["raw/a.md"] });
  conflict.domain.seed("raw/a.md", "raw a");
  conflict.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  conflict.domain.beforeReadback = (relativePath, count) => {
    if (relativePath === "wiki/phase3-summary.md" && count === 2) {
      conflict.domain.externalSet(relativePath, "user changed target");
    }
  };
  await assert.rejects(
    conflict.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("cas-conflict")
    }),
    phase3Error("preview_stale")
  );
  assert.equal(conflict.domain.formalWrites.length, 0);
  assert.equal(
    conflict.domain.content("wiki/phase3-summary.md"),
    "user changed target"
  );
}

async function assertAgentExpectedExistingTargetRejectsConcurrentEdit():
Promise<void> {
  const original = "existing target before Agent read";
  const concurrent = "user edit after Agent read";
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => proposalWithAgentExpectedTarget(
      defaultProposal(input),
      "wiki/phase3-summary.md",
      {
        kind: "file",
        contentRevision: `sha256:${sha256(original)}`
      }
    )
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  fixture.domain.seed("wiki/phase3-summary.md", original);
  fixture.proposal.afterGenerate = () => {
    fixture.domain.externalSet("wiki/phase3-summary.md", concurrent);
  };

  await assert.rejects(
    fixture.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("agent-existing-target-stale")
    }),
    phase3Error("preview_stale")
  );
  assert.equal(fixture.domain.content("wiki/phase3-summary.md"), concurrent);
  assert.equal(fixture.domain.formalWrites.length, 0);
  assert.equal(await fixture.state.loadWal("preview-1"), null);
}

async function assertAgentExpectedMissingTargetRejectsConcurrentCreate():
Promise<void> {
  const concurrent = "file created after Agent checked missing";
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => proposalWithAgentExpectedTarget(
      defaultProposal(input),
      "wiki/phase3-summary.md",
      { kind: "missing" }
    )
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  fixture.proposal.afterGenerate = () => {
    fixture.domain.externalSet("wiki/phase3-summary.md", concurrent);
  };

  await assert.rejects(
    fixture.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("agent-missing-target-stale")
    }),
    phase3Error("preview_stale")
  );
  assert.equal(fixture.domain.content("wiki/phase3-summary.md"), concurrent);
  assert.equal(fixture.domain.formalWrites.length, 0);
  assert.equal(await fixture.state.loadWal("preview-1"), null);
}

async function assertAgentExpectedExistingTargetAllowsUnchangedUpdate():
Promise<void> {
  const original = "existing target read by Agent";
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => proposalWithAgentExpectedTarget(
      defaultProposal(input),
      "wiki/phase3-summary.md",
      {
        kind: "file",
        contentRevision: `sha256:${sha256(original)}`
      }
    )
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  fixture.domain.seed("wiki/phase3-summary.md", original);

  const result = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    toolCall: toolCallFor("agent-existing-target-current")
  });
  assert.equal(result.status, "completed");
  assert.match(
    fixture.domain.content("wiki/phase3-summary.md") ?? "",
    /knowledge from raw\/a\.md/u
  );
  assert.equal(
    fixture.domain.formalWrites.filter((path) =>
      path === "wiki/phase3-summary.md"
    ).length,
    1
  );
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "completed");
}

async function assertCandidateActionExpectedTargetIsStrict(): Promise<void> {
  const identity = Object.freeze({
    vaultId: VAULT_ID,
    conversationId: "conversation-phase3",
    piSessionId: "pi-session-phase3",
    productRunId: "run-expected-target-security"
  });
  const security = createPiKnowledgeMaintenanceToolSecurity({
    currentRunIdentity: () => identity,
    currentCommand: () => Object.freeze({
      mode: "maintain" as const,
      request: "raw/a.md",
      scope: Object.freeze({
        mode: "query" as const,
        candidatePaths: Object.freeze(["raw/a.md"])
      }),
      preference: Object.freeze({
        ...PREFERENCE,
        providerResourceText: "PREFERENCE_FIXTURE"
      })
    }),
    egress: { assertAllowed: () => undefined }
  });
  const invalidActions = [
    {
      targetPath: "wiki/missing-binding.md",
      content: "missing expectedTarget"
    },
    {
      targetPath: "wiki/invalid-revision.md",
      content: "invalid revision",
      expectedTarget: { kind: "file", contentRevision: "sha256:INVALID" }
    },
    {
      targetPath: "wiki/unknown-field.md",
      content: "unknown expectedTarget field",
      expectedTarget: { kind: "missing", unexpected: true }
    }
  ];
  for (const [index, action] of invalidActions.entries()) {
    assert.deepEqual(await security.handleToolCall({
      toolName: "knowledge_maintain",
      toolCallId: `invalid-expected-target-${index}`,
      input: { candidateActions: [action] }
    } as never, undefined), {
      block: true,
      reason: "tool_policy_blocked"
    });
  }
}

async function assertKnowledgeCandidatesRequireExactRawSources(): Promise<void> {
  const scenarios = [
    {
      name: "missing source",
      content: "knowledge without source"
    },
    {
      name: "link without marker",
      content: "来源：[[raw/a.md|原始材料]]"
    },
    {
      name: "wrong revision",
      content: [
        "来源：[[raw/a.md|原始材料]]",
        sourceMarker("raw/a.md", "f".repeat(64))
      ].join("\n")
    },
    {
      name: "unlocked source",
      content: [
        "来源：[[raw/not-selected.md|原始材料]]",
        sourceMarker("raw/not-selected.md", sha256("not selected"))
      ].join("\n")
    }
  ] as const;
  for (const scenario of scenarios) {
    const fixture = createFixture({
      trackerPaths: ["raw/a.md"],
      proposalFactory: (input) => defaultProposal(input, [], scenario.content)
    });
    fixture.domain.seed("raw/a.md", "raw a");
    fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
    await assert.rejects(
      fixture.service.execute({
        vaultId: VAULT_ID,
        dateKey: DATE_KEY,
        preference: PREFERENCE,
        toolCall: toolCallFor(`source-${scenario.name}`)
      }),
      phase3Error("proposal_invalid"),
      scenario.name
    );
    assert.equal(fixture.domain.formalWrites.length, 0, scenario.name);
  }
}

async function assertWalRecoveryDoesNotRegenerateOrRepeatWrite(): Promise<void> {
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    faultInjector: () => {
      throw new Phase3MaintenanceSimulatedReload();
    }
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  await assert.rejects(
    fixture.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("wal-reload")
    }),
    Phase3MaintenanceSimulatedReload
  );
  assert.equal(fixture.domain.formalWrites.length, 0);
  assert.equal(fixture.proposal.calls, 1);
  const persistedWal = (await fixture.state.listRecoverableWals(VAULT_ID))[0];
  assert.equal(persistedWal?.status, "prepared");
  assert.equal(
    persistedWal?.authorization.contract.productRunId,
    "run-wal-reload"
  );
  assert.equal(
    persistedWal?.authorization.contract.toolCallId,
    "call-wal-reload"
  );
  assert.equal(
    persistedWal?.preview.preferenceRevision,
    PREFERENCE.revision
  );
  assert.equal(
    persistedWal?.authorization.contract.preferenceRevision,
    PREFERENCE.revision
  );

  const recoveredService = fixture.createService();
  const recovered = await recoveredService.recoverPending(VAULT_ID);
  assert.deepEqual(recovered, {
    recovered: 1,
    blocked: 0,
    issues: []
  });
  assert.equal(fixture.proposal.calls, 1);
  const writeCount = fixture.domain.formalWrites.length;
  assert.equal(writeCount, 4);
  const replay = await recoveredService.recoverPending(VAULT_ID);
  assert.deepEqual(replay, { recovered: 0, blocked: 0, issues: [] });
  assert.equal(fixture.domain.formalWrites.length, writeCount);
}

async function assertTruncatedLargeKnowledgeReadbackStillProducesNote():
Promise<void> {
  const content = [
    "# 大文件回读标题",
    "",
    "大文件最终回读摘要。",
    "x".repeat(9_000),
    "来源：[[raw/a.md|原始材料]]",
    sourceMarker("raw/a.md", sha256("raw a"))
  ].join("\n");
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => defaultProposal(input, [], content)
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  fixture.domain.truncateReadback("wiki/phase3-summary.md", 8_000);

  const result = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    toolCall: toolCallFor("large-readback")
  });

  assert.equal(Buffer.byteLength(content, "utf8") > 8_192, true);
  assert.equal(result.status, "completed");
  assert.equal(result.readbackVerified, true);
  assert.deepEqual(result.notes, [{
    operation: "created",
    path: "wiki/phase3-summary.md",
    title: "大文件回读标题",
    summary: "大文件最终回读摘要。"
  }]);
}

async function assertBlockedWalRejectsNextMaintenance(): Promise<void> {
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    faultInjector: () => {
      throw new Phase3MaintenanceSimulatedReload();
    }
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  await assert.rejects(
    fixture.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("blocked-seed")
    }),
    Phase3MaintenanceSimulatedReload
  );
  fixture.domain.externalSet("raw/a.md", "raw changed after WAL");
  const recoveredService = fixture.createService();
  const firstRecovery = await recoveredService.recoverPending(VAULT_ID);
  assert.equal(firstRecovery.blocked, 1);
  assert.equal(
    (await fixture.state.loadWal("preview-1"))?.status,
    "blocked"
  );
  const proposalCalls = fixture.proposal.calls;
  const formalWrites = [...fixture.domain.formalWrites];

  await assert.rejects(
    recoveredService.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("blocked-next")
    }),
    phase3Error("recovery_blocked")
  );
  assert.equal(fixture.proposal.calls, proposalCalls);
  assert.deepEqual(fixture.domain.formalWrites, formalWrites);
}

async function assertCompletedCheckpointFailureIsWriteUncertainAndRecoveredFirst():
Promise<void> {
  let proposalCall = 0;
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => {
      proposalCall += 1;
      return proposalCall === 1
        ? defaultProposal(input)
        : defaultProposal(input, [{
            targetPath: "outputs/not-allowed.md",
            content: "must not create a new WAL"
          }]);
    }
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  const reportPath = phase3MaintenanceReportPath(DATE_KEY);
  fixture.state.failNextCompletedActionCheckpoint(reportPath);

  const uncertain = await fixture.service.execute({
    vaultId: VAULT_ID,
    dateKey: DATE_KEY,
    preference: PREFERENCE,
    toolCall: toolCallFor("checkpoint-uncertain")
  });
  assert.equal(uncertain.status, "write_uncertain");
  assert.equal(fixture.domain.content(reportPath)?.startsWith("report for"), true);
  assert.equal(
    fixture.domain.formalWrites.filter((path) => path === reportPath).length,
    1
  );
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "applying");

  await assert.rejects(
    fixture.createService().execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("checkpoint-next")
    }),
    phase3Error("proposal_invalid")
  );
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "completed");
  assert.equal(
    fixture.domain.formalWrites.filter((path) => path === reportPath).length,
    1,
    "recovery must checkpoint the existing bytes without repeating the write"
  );
  assert.equal(await fixture.state.loadWal("preview-2"), null);
}

async function assertRecoveredWalRejectsCandidatesBuiltBeforeRecovery():
Promise<void> {
  let proposalCall = 0;
  const recoveredKnowledge = [
    "# 恢复后的知识",
    "",
    "旧 WAL 应完成这次写入。",
    `来源：[[raw/a.md|原始材料]]`,
    sourceMarker("raw/a.md", sha256("raw a"))
  ].join("\n");
  const staleCandidate = [
    "# 恢复前的过时候选",
    "",
    "不得覆盖刚由旧 WAL 恢复的知识。",
    `来源：[[raw/a.md|原始材料]]`,
    sourceMarker("raw/a.md", sha256("raw a"))
  ].join("\n");
  const fixture = createFixture({
    trackerPaths: ["raw/a.md"],
    proposalFactory: (input) => {
      proposalCall += 1;
      return defaultProposal(
        input,
        [],
        proposalCall === 1 ? recoveredKnowledge : staleCandidate
      );
    },
    faultInjector: () => {
      throw new Phase3MaintenanceSimulatedReload();
    }
  });
  fixture.domain.seed("raw/a.md", "raw a");
  fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker");
  await assert.rejects(
    fixture.service.execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("stale-candidate-seed")
    }),
    Phase3MaintenanceSimulatedReload
  );

  await assert.rejects(
    fixture.createService().execute({
      vaultId: VAULT_ID,
      dateKey: DATE_KEY,
      preference: PREFERENCE,
      toolCall: toolCallFor("stale-candidate-next")
    }),
    (error: unknown) => error instanceof Phase3MaintenanceError
      && error.code === "proposal_invalid"
      && /run \/maintain again/iu.test(error.message)
  );
  assert.equal(proposalCall, 1, "stale candidates must not be regenerated or consumed");
  assert.equal(
    fixture.domain.content("wiki/phase3-summary.md"),
    recoveredKnowledge
  );
  assert.equal(fixture.domain.formalWrites.length, 4);
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "completed");
  assert.equal(await fixture.state.loadWal("preview-2"), null);
}

function toolCallFor(
  suffix: string
): Readonly<Phase3MaintenanceConfirmToolCallContext> {
  return Object.freeze({
    productRunId: `run-${suffix}`,
    toolCallId: `call-${suffix}`,
    conversationId: "conversation-phase3",
    piSessionId: "pi-session-phase3",
    vaultId: VAULT_ID,
    userId: "user-phase3",
    deviceId: "device-phase3"
  });
}

interface FixtureOptions {
  trackerPaths: readonly string[];
  proposalFactory?: (
    input: Readonly<Phase3MaintenanceProposalInput>
  ) => Readonly<Phase3MaintenanceProposal>;
  faultInjector?: () => void;
}

function createFixture(options: FixtureOptions): {
  domain: FakeVaultDomain;
  sources: FakeSourceSnapshots;
  tracker: FakeTracker;
  proposal: FakeProposal;
  approvals: FakeApprovals;
  state: InMemoryPhase3StateStore;
  service: Phase3KnowledgeMaintenanceService;
  createService(): Phase3KnowledgeMaintenanceService;
} {
  const domain = new FakeVaultDomain();
  const sources = new FakeSourceSnapshots(domain);
  const tracker = new FakeTracker(domain, options.trackerPaths);
  const proposal = new FakeProposal(options.proposalFactory);
  const approvals = new FakeApprovals();
  const state = new InMemoryPhase3StateStore();
  let previewSequence = 0;
  const createService = (faultInjector?: () => void) =>
    new Phase3KnowledgeMaintenanceService({
      domain,
      sources,
      tracker,
      proposal,
      approvals,
      state,
      createPreviewId: () => `preview-${++previewSequence}`,
      now: () => 1_785_715_200_000 + previewSequence,
      ...(faultInjector ? { faultInjector } : {})
    });
  return {
    domain,
    sources,
    tracker,
    proposal,
    approvals,
    state,
    service: createService(options.faultInjector),
    createService: () => createService()
  };
}

class FakeVaultDomain {
  readonly formalWrites: string[] = [];
  beforeReadback?: (relativePath: string, count: number) => void;
  private readonly files = new Map<string, string>();
  private readonly readbackCounts = new Map<string, number>();
  private readonly truncatedReadbacks = new Map<string, number>();

  truncateReadback(relativePath: string, prefixBytes: number): void {
    this.truncatedReadbacks.set(relativePath, prefixBytes);
  }

  seed(relativePath: string, content: string): void {
    this.files.set(relativePath, content);
  }

  externalSet(relativePath: string, content: string): void {
    this.files.set(relativePath, content);
  }

  content(relativePath: string): string | undefined {
    return this.files.get(relativePath);
  }

  digest(relativePath: string): string | undefined {
    const content = this.files.get(relativePath);
    return content === undefined ? undefined : sha256(content);
  }

  fileBinding(relativePath: string): Phase3MaintenanceTargetBinding {
    const content = this.files.get(relativePath);
    if (content === undefined) return { kind: "missing" };
    return {
      kind: "file",
      version: sha256(content),
      contentSha256: sha256(content),
      byteLength: Buffer.byteLength(content, "utf8")
    };
  }

  immutableBinding(relativePath: string): Phase3MaintenanceImmutableFileBinding {
    const content = this.files.get(relativePath);
    if (content === undefined) throw new Error(`missing fixture file: ${relativePath}`);
    return {
      kind: "file",
      relativePath,
      revision: sha256(content),
      contentSha256: sha256(content),
      byteLength: Buffer.byteLength(content, "utf8")
    };
  }

  async readback(input: Readonly<{
    vaultId: string;
    relativePath: string;
  }>): Promise<Readonly<VaultReadbackState>> {
    assert.equal(input.vaultId, VAULT_ID);
    const count = (this.readbackCounts.get(input.relativePath) ?? 0) + 1;
    this.readbackCounts.set(input.relativePath, count);
    this.beforeReadback?.(input.relativePath, count);
    return this.readbackState(input.relativePath);
  }

  async noteCreate(input: Readonly<{
    vaultId: string;
    operationIdentity: string;
    relativePath: string;
    content: string;
  }>): Promise<Readonly<VaultOperationResult>> {
    assert.equal(input.vaultId, VAULT_ID);
    if (this.files.has(input.relativePath)) {
      return this.failedResult(
        input.operationIdentity,
        "note_create",
        input.relativePath,
        "target_exists"
      );
    }
    this.files.set(input.relativePath, input.content);
    this.formalWrites.push(input.relativePath);
    return this.completedResult(
      input.operationIdentity,
      "note_create",
      input.relativePath
    );
  }

  async noteUpdate(input: Readonly<{
    vaultId: string;
    operationIdentity: string;
    relativePath: string;
    expectedVersion: string;
    content: string;
  }>): Promise<Readonly<VaultOperationResult>> {
    assert.equal(input.vaultId, VAULT_ID);
    const current = this.files.get(input.relativePath);
    if (current === undefined || sha256(current) !== input.expectedVersion) {
      return this.failedResult(
        input.operationIdentity,
        "note_update",
        input.relativePath,
        "version_conflict"
      );
    }
    this.files.set(input.relativePath, input.content);
    this.formalWrites.push(input.relativePath);
    return this.completedResult(
      input.operationIdentity,
      "note_update",
      input.relativePath
    );
  }

  private readbackState(relativePath: string): Readonly<VaultReadbackState> {
    const content = this.files.get(relativePath);
    if (content === undefined) return Object.freeze({ status: "missing" });
    const digest = sha256(content);
    const prefixBytes = this.truncatedReadbacks.get(relativePath);
    const readbackContent = prefixBytes === undefined
      ? content
      : Buffer.from(content, "utf8").subarray(0, prefixBytes).toString("utf8");
    return Object.freeze({
      status: "present",
      snapshot: Object.freeze({
        relativePath,
        version: digest,
        byteLength: Buffer.byteLength(content, "utf8"),
        content: readbackContent,
        contentSha256: digest,
        truncated: prefixBytes !== undefined
      })
    });
  }

  private completedResult(
    operationIdentity: string,
    operation: "note_create" | "note_update",
    relativePath: string
  ): Readonly<VaultOperationResult> {
    return Object.freeze({
      operationIdentity,
      operation,
      status: "completed",
      sourcePath: relativePath,
      sideEffectStarted: true,
      readbackVerified: true,
      readback: Object.freeze({ source: this.readbackState(relativePath) })
    });
  }

  private failedResult(
    operationIdentity: string,
    operation: "note_create" | "note_update",
    relativePath: string,
    code: string
  ): Readonly<VaultOperationResult> {
    return Object.freeze({
      operationIdentity,
      operation,
      status: "failed",
      sourcePath: relativePath,
      sideEffectStarted: false,
      readbackVerified: false,
      readback: Object.freeze({ source: this.readbackState(relativePath) }),
      error: Object.freeze({ code, message: code })
    });
  }
}

class FakeSourceSnapshots implements Phase3MaintenanceSourceSnapshotPort {
  readonly attachments = new Map<string, readonly string[]>();

  constructor(private readonly domain: FakeVaultDomain) {}

  async snapshotRaw(input: Readonly<{
    vaultId: string;
    relativePath: string;
  }>): Promise<Readonly<Phase3MaintenanceSourceBinding>> {
    assert.equal(input.vaultId, VAULT_ID);
    return Object.freeze({
      raw: this.domain.immutableBinding(input.relativePath),
      attachments: Object.freeze(
        (this.attachments.get(input.relativePath) ?? []).map((relativePath) =>
          this.domain.immutableBinding(relativePath))
      )
    });
  }
}

class FakeTracker implements Phase3MaintenanceTrackerPort {
  constructor(
    private readonly domain: FakeVaultDomain,
    private readonly paths: readonly string[]
  ) {}

  async snapshot(input: Readonly<{
    vaultId: string;
  }>): Promise<Readonly<Phase3MaintenanceTrackerSnapshot>> {
    assert.equal(input.vaultId, VAULT_ID);
    return Object.freeze({
      binding: this.domain.fileBinding(PHASE3_MAINTENANCE_TRACKER_PATH),
      changedRawPaths: Object.freeze([...this.paths])
    });
  }
}

class FakeProposal implements Phase3MaintenanceProposalPort {
  calls = 0;
  lastInput: Readonly<Phase3MaintenanceProposalInput> | null = null;
  afterGenerate?: () => void;

  constructor(private readonly factory?: (
    input: Readonly<Phase3MaintenanceProposalInput>
  ) => Readonly<Phase3MaintenanceProposal>) {}

  async generate(
    input: Readonly<Phase3MaintenanceProposalInput>
  ): Promise<Readonly<Phase3MaintenanceProposal>> {
    this.calls += 1;
    this.lastInput = input;
    const proposal = this.factory?.(input) ?? defaultProposal(input);
    this.afterGenerate?.();
    return proposal;
  }
}

function defaultProposal(
  input: Readonly<Phase3MaintenanceProposalInput>,
  additional: readonly { targetPath: string; content: string }[] = [],
  knowledgeContent?: string
): Readonly<Phase3MaintenanceProposal> {
  const selected = input.selectedSources
    .map((source) => source.raw.relativePath)
    .join(", ");
  const remaining = input.remainingRawPaths.length
    ? `\nremaining: ${input.remainingRawPaths.join(", ")}`
    : "";
  return Object.freeze({
    shadowId: `shadow-${input.previewId}`,
    shadowRevision: `sealed-${input.previewId}`,
    actions: Object.freeze([
      {
        targetPath: input.reportPath,
        content: `report for ${selected}${remaining}`
      },
      {
        targetPath: PHASE3_MAINTENANCE_TRACKER_PATH,
        content: `processed: ${selected}`
      },
      ...additional,
      {
        targetPath: "wiki/phase3-summary.md",
        expectedTarget: { kind: "missing" as const },
        content: knowledgeContent ?? [
          `knowledge from ${selected}`,
          ...input.selectedSources.flatMap((source) => [
            `来源：[[${source.raw.relativePath}|原始材料]]`,
            sourceMarker(
              source.raw.relativePath,
              source.raw.contentSha256
            )
          ])
        ].join("\n")
      },
      {
        targetPath: PHASE3_MAINTENANCE_RAW_INDEX_PATH,
        content: `index: ${selected}`
      }
    ])
  });
}

function structuredNoopProposal(
  input: Readonly<Phase3MaintenanceProposalInput>
): Readonly<Phase3MaintenanceProposal> {
  const selected = input.selectedSources
    .map((source) => source.raw.relativePath)
    .join(", ");
  return Object.freeze({
    shadowId: `shadow-${input.previewId}`,
    shadowRevision: `sealed-noop-${input.previewId}`,
    actions: Object.freeze([
      Object.freeze({
        targetPath: input.reportPath,
        content: `noop report for ${selected}`
      }),
      Object.freeze({
        targetPath: PHASE3_MAINTENANCE_TRACKER_PATH,
        content: `processed: ${selected}`
      }),
      Object.freeze({
        targetPath: PHASE3_MAINTENANCE_RAW_INDEX_PATH,
        content: `index: ${selected}`
      })
    ])
  });
}

function proposalWithAgentExpectedTarget(
  proposal: Readonly<Phase3MaintenanceProposal>,
  targetPath: string,
  expectedTarget: Readonly<
    | { kind: "missing" }
    | { kind: "file"; contentRevision: string }
  >
): Readonly<Phase3MaintenanceProposal> {
  return Object.freeze({
    ...proposal,
    actions: Object.freeze(proposal.actions.map((action) =>
      action.targetPath === targetPath
        ? Object.freeze({ ...action, expectedTarget })
        : action
    ))
  });
}

function sourceMarker(relativePath: string, digest: string): string {
  return `<!-- echoink-source: ${JSON.stringify({
    path: relativePath,
    revision: `sha256:${digest}`
  })} -->`;
}

function freezeApprovalContract(
  input: Readonly<Phase3MaintenanceApprovalContract>
): Readonly<Phase3MaintenanceApprovalContract> {
  return Object.freeze({
    productRunId: input.productRunId,
    toolCallId: input.toolCallId,
    conversationId: input.conversationId,
    piSessionId: input.piSessionId,
    vaultId: input.vaultId,
    userId: input.userId,
    deviceId: input.deviceId,
    previewId: input.previewId,
    previewDigest: input.previewDigest,
    preferenceProfileVersion: input.preferenceProfileVersion,
    preferenceState: input.preferenceState,
    preferenceRevision: input.preferenceRevision,
    orderedActions: Object.freeze(input.orderedActions.map((action) =>
      Object.freeze({
        ...action,
        expected: Object.freeze({ ...action.expected })
      })))
  });
}

class FakeApprovals implements Phase3MaintenanceBatchApprovalPort {
  issued = 0;
  confirmed = 0;
  consumed = 0;
  nextTicketProductRunId: string | undefined;
  lastContract: Readonly<Phase3MaintenanceApprovalContract> | null = null;

  async authorize(
    input: Readonly<Phase3MaintenanceBatchApprovalInput>
  ): Promise<Readonly<Phase3MaintenanceBatchAuthorization>> {
    const approvalId = `approval-${++this.issued}`;
    const contract = freezeApprovalContract({
      ...input,
      productRunId: this.nextTicketProductRunId ?? input.productRunId
    });
    this.lastContract = contract;
    this.confirmed += 1;
    const expected = freezeApprovalContract(input);
    if (!isDeepStrictEqual(contract, expected)) {
      throw new Error("cross-run approval ticket");
    }
    this.consumed += 1;
    return Object.freeze({
      approvalId,
      operationIdentity: `operation-${approvalId}`,
      consumedAt: 1_785_715_200_100 + this.consumed,
      contract
    });
  }
}

class InMemoryPhase3StateStore implements Phase3MaintenanceStateStore {
  private readonly previews = new Map<string, Phase3MaintenanceStoredPreview>();
  private readonly wals = new Map<string, Readonly<Phase3MaintenanceWalRecord>>();
  private failCompletedActionCheckpointPath: string | null = null;

  failNextCompletedActionCheckpoint(targetPath: string): void {
    this.failCompletedActionCheckpointPath = targetPath;
  }

  async createPreview(preview: Parameters<Phase3MaintenanceStateStore["createPreview"]>[0]): Promise<void> {
    if (this.previews.has(preview.previewId)) throw new Error("preview exists");
    this.previews.set(preview.previewId, { preview, status: "active" });
  }

  async loadPreview(previewId: string): Promise<Readonly<Phase3MaintenanceStoredPreview> | null> {
    return this.previews.get(previewId) ?? null;
  }

  async setPreviewStatus(input: Readonly<{
    previewId: string;
    expected: Phase3MaintenanceStoredPreview["status"];
    status: Phase3MaintenanceStoredPreview["status"];
    reason?: string;
  }>): Promise<void> {
    const current = this.previews.get(input.previewId);
    if (!current || current.status !== input.expected) {
      throw new Error("preview status conflict");
    }
    this.previews.set(input.previewId, {
      preview: current.preview,
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {})
    });
  }

  async createWal(
    wal: Readonly<Phase3MaintenanceWalRecord>
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    const existing = this.wals.get(wal.preview.previewId);
    if (existing) {
      if (existing.preview.previewDigest !== wal.preview.previewDigest) {
        throw new Error("wal conflict");
      }
      return existing;
    }
    this.wals.set(wal.preview.previewId, wal);
    return wal;
  }

  async loadWal(previewId: string): Promise<Readonly<Phase3MaintenanceWalRecord> | null> {
    return this.wals.get(previewId) ?? null;
  }

  async listRecoverableWals(
    vaultId: string
  ): Promise<readonly Readonly<Phase3MaintenanceWalRecord>[]> {
    return [...this.wals.values()].filter((wal) =>
      wal.preview.vaultId === vaultId
      && wal.status !== "completed");
  }

  async saveWal(
    wal: Readonly<Phase3MaintenanceWalRecord>,
    expectedSequence: number
  ): Promise<Readonly<Phase3MaintenanceWalRecord>> {
    const current = this.wals.get(wal.preview.previewId);
    if (!current || current.sequence !== expectedSequence) {
      throw new Error("wal sequence conflict");
    }
    if (
      this.failCompletedActionCheckpointPath !== null
      && wal.actions.some((entry, index) =>
        entry.status === "completed"
        && current.actions[index]?.status !== "completed"
        && entry.action.targetPath === this.failCompletedActionCheckpointPath
      )
    ) {
      this.failCompletedActionCheckpointPath = null;
      throw new Error("fixture completed checkpoint failed");
    }
    this.wals.set(wal.preview.previewId, wal);
    return wal;
  }
}

function phase3Error(code: Phase3MaintenanceError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof Phase3MaintenanceError
    && error.code === code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
