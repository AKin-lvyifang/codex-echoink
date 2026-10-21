import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../../knowledge-base/root-paths";
import { readPrivateMaintenanceRecords } from "../../plugin/pi-knowledge-maintenance-production";
import { rawDigestFingerprint, readRawDigestRegistry, writeRawDigestRegistry } from "../../knowledge-base/raw-digest";
import { KnowledgeAgentIndex } from "../../knowledge-base/knowledge-agent-index";
import { VaultBodySearch } from "../../knowledge-base/vault-body-search";
import { KnowledgeRetriever } from "../../knowledge-base/query";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../../harness/pi-native/pi-knowledge-read-tools";
import { recordMaintenanceSourceBodyFingerprint, maintenanceSourceFingerprintsFromEntries } from "../../harness/pi-native/pi-knowledge-maintenance-tool";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { discoverKnowledgeBaseSources } from "../../knowledge-base/discovery";
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
  completeKnowledgeMaintenanceCandidateSources,
  validateKnowledgeMaintenanceCandidateSources,
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
  await runPreservedMaintenanceSourceTests();
  await runMaintenanceReadFingerprintTests();
  assertProtocolAllowsNaturalCompletion();
  assertProtocolDelegatesPlacementToBackground();
  assertStrictDurableResultEnvelope();
  await assertMaintenanceScopeSecurityIsFailClosed();
  await assertReliableExistingKnowledgeReturnsNoopBeforeWrites();
  await assertProductionStructuredNoopCompletesChangedRaw();
  await assertPrivateRecordsRecoverWithoutRewriting();
  await assertCorruptPrivateHistoryDoesNotBlockMaintenanceOrRetry();
  await assertFailedNaturalSettlementKeepsEverySourcePending();
  await assertPrivateSettlementBoundaries();
  await assertOriginalV1WalNeverRevivesRetiredFiles();
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
  await assertStaleUnwrittenWalDoesNotBlockCorrection();
  await assertCompletedCheckpointFailureIsWriteUncertainAndRecoveredFirst();
  await assertRecoveredWalContinuesWithCurrentTargets();
}

export async function runPreservedMaintenanceSourceTests(): Promise<void> {
  const targetPath = "wiki/phase3-summary.md", prior = "raw/previous.md", current = "raw/current.md", outside = "raw/forged.md";
  const baselineContent = `# Existing\n[[${prior}|原始材料]]\n${sourceMarker(prior, "a".repeat(64))}\n`;
  const selectedSources = [{ relativePath: current, contentSha256: "b".repeat(64) }];
  const content = `${baselineContent}\nNew claim [[${current}|原始材料]]\n`;
  const completed = completeKnowledgeMaintenanceCandidateSources({ targetPath, content, baselineContent, selectedSources });
  const adopted = validateKnowledgeMaintenanceCandidateSources({ targetPath, content: completed, baselineContent, selectedSources });
  assert.deepEqual(adopted.map(source => source.relativePath), [current], "retained previous sources are not processed by this batch");
  assert.match(completed, new RegExp(`"revision":"sha256:${"a".repeat(64)}"`, "u"));
  for (const extra of [`\n[[${outside}|新越界来源]]\n`, `\n[[${outside}]]\n${sourceMarker(outside, "c".repeat(64))}\n`]) {
    assert.throws(() => completeKnowledgeMaintenanceCandidateSources({ targetPath, content: content + extra, baselineContent, selectedSources }), /来源不在本次范围/u);
  }
  assert.throws(() => completeKnowledgeMaintenanceCandidateSources({ targetPath, content: content.replace("a".repeat(64), "c".repeat(64)), baselineContent, selectedSources }), /旧来源标记已变化/u);
  const customRole = (relative: string) => relative.startsWith("Sources/") ? `raw/${relative.slice("Sources/".length)}` : relative;
  const customBaseline = baselineContent.replaceAll("raw/", "Sources/");
  assert.throws(() => completeKnowledgeMaintenanceCandidateSources({ targetPath: "Wiki/summary.md", content: content.replaceAll("raw/", "Sources/") + "\n[[Sources/third.md]]\n", baselineContent: customBaseline,
    selectedSources: [{ relativePath: "Sources/current.md", contentSha256: "b".repeat(64) }] }, customRole), /来源不在本次范围/u);
  const fixture = createFixture({ trackerPaths: [current], proposalFactory: input => {
    const proposal = defaultProposal(input);
    return { ...proposal, actions: proposal.actions.map(action => action.targetPath !== targetPath ? action : { ...action,
      expectedTarget: { kind: "file" as const, contentRevision: `sha256:${sha256(baselineContent)}` },
      baselineContent: baselineContent + `\n[[${outside}]]\n${sourceMarker(outside, "c".repeat(64))}\n`,
      content: completed }) };
  } });
  fixture.domain.seed(current, "current raw"); fixture.domain.seed(PHASE3_MAINTENANCE_TRACKER_PATH, "tracker"); fixture.domain.seed(targetPath, baselineContent);
  await assert.rejects(fixture.service.execute({ vaultId: VAULT_ID, dateKey: DATE_KEY, preference: PREFERENCE, toolCall: toolCallFor("forged-baseline") }), phase3Error("preview_stale"));
  assert.equal(fixture.domain.formalWrites.length, 0, "a self-reported baseline cannot grant source preservation");
  console.log("PASS preserved sources: server-bound baseline, retained revisions, current-batch evidence only, new source/forged marker/forged baseline refusal");
}

export async function runMaintenanceReadFingerprintTests(): Promise<void> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-raw-read-fingerprint-")));
  const vault = path.join(root, "vault"), sourcePath = "raw/source.md";
  const original = "---\ntags: [fixture]\n---\n# Source\nRAW_BRIDGE_TOKEN canonical body.\nSecond body line.\n";
  const domain = new FakeVaultDomain(vault);
  await fsp.mkdir(path.join(vault, "raw"), { recursive: true });
  const setSource = async (text: string) => { await fsp.writeFile(path.join(vault, sourcePath), text); domain.seed(sourcePath, text); };
  await setSource(original);
  const canonical = rawDigestFingerprint(sourcePath, Buffer.from(original));
  const fullRevision = `sha256:${sha256(original)}`;
  assert.notEqual(canonical.split(":").at(-1), fullRevision.split(":").at(-1));
  const file = { path: sourcePath, basename: "source", extension: "md", stat: { mtime: 1, size: Buffer.byteLength(original) } };
  const app = { vault: { getMarkdownFiles: () => [file], getAbstractFileByPath: (p: string) => p === sourcePath ? file : null,
    read: async () => fsp.readFile(path.join(vault, sourcePath), "utf8") }, metadataCache: { getFileCache: () => null } };
  const bodySearch = new VaultBodySearch(app as never, () => null);
  const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: path.join(root, "index"), bodySearch });
  const maintenance = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: path.join(root, "private"), vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, dateKey: () => DATE_KEY });
  let sequence = 0;
  try {
    await maintenance.initialize();
    for (const order of ["note-search", "search-note", "parallel", "knowledge-only"] as const) {
      await setSource(original); bodySearch.invalidate();
      const fingerprints: Record<string, string> = {};
      const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: VAULT_ID, conversationId: order, piSessionId: order, productRunId: order }), currentWorkflow: () => "maintain",
        onSourceRead: (reference, bodyFingerprint) => recordMaintenanceSourceBodyFingerprint(fingerprints, reference.vaultRelativePath, bodyFingerprint, vault), egress: new EchoInkVaultToolEgressPolicy() });
      const tools = createPiKnowledgeReadToolDefinitions({ retriever: new KnowledgeRetriever(vault, { agentIndex: index }), security });
      const invoke = async (name: "knowledge_search" | "knowledge_read", args: unknown) => {
        const id = `bridge-${++sequence}`;
        await security.handleToolCall({ toolName: name, toolCallId: id, input: args } as never, undefined);
        await tools.find(tool => tool.name === name)!.execute(id, args as never, undefined, undefined);
        const result = await security.handleToolResult({ toolName: name, toolCallId: id, isError: false } as never);
        assert.equal(result.isError, false);
        return result;
      };
      const note = async () => { await Promise.resolve(); recordMaintenanceSourceBodyFingerprint(fingerprints, sourcePath, canonical, vault); };
      const search = () => invoke("knowledge_search", { query: "RAW_BRIDGE_TOKEN" });
      if (order === "note-search") { await note(); await search(); }
      if (order === "search-note") { await search(); await note(); }
      if (order === "parallel") await Promise.all([note(), search()]);
      if (order === "knowledge-only") {
        await search();
        assert.deepEqual(fingerprints, {}, "search fragments never establish a full Raw read");
        const partial = await invoke("knowledge_read", { vaultRelativePath: sourcePath, expectedContentRevision: fullRevision, lineStart: 5, lineCount: 1 });
        assert.equal((partial.details as any).sourceBodyFingerprints, undefined);
        assert.deepEqual(fingerprints, {}, "a partial read cannot establish a full Raw fingerprint");
        const complete = await invoke("knowledge_read", { vaultRelativePath: sourcePath, expectedContentRevision: fullRevision, lineStart: 1, lineCount: 80 });
        const restored = maintenanceSourceFingerprintsFromEntries([{ type: "message", message: { role: "toolResult", toolName: "knowledge_read", isError: false, details: complete.details } }] as never, vault);
        assert.deepEqual(restored, { [sourcePath]: canonical });
        assert.equal((complete.details as any).references[0].contentRevision, fullRevision, "citation identity remains the full file revision");
      }
      assert.equal(fingerprints[sourcePath], canonical);
      const input = { vaultId: VAULT_ID, conversationId: order, piSessionId: order, productRunId: order, toolCallId: order, mode: "maintain" as const, request: "", sourcePaths: [sourcePath], sourceBodyFingerprints: fingerprints, preferenceSnapshot: PREFERENCE, candidateActions: [] };
      const result = await maintenance.execute(input);
      assert.equal(result.status, "completed", `first unchanged maintenance must succeed: ${JSON.stringify(result)}`);
      await setSource(original + "Actual new fact.\n");
      const changed = await maintenance.execute({ ...input, toolCallId: `${order}-changed`, productRunId: `${order}-changed` });
      assert.equal(changed.status, "failed"); assert.equal(changed.errorCode, "preview_stale", "true body changes retain the original comparison");
    }
  } finally { bodySearch.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
  console.log("PASS Raw maintenance fingerprints: note/search order and concurrency, full knowledge_read, partial refusal and true changes");
}

function assertProtocolAllowsNaturalCompletion(): void {
  const prompt = echoInkKnowledgeMaintenanceProtocolPrompt();
  assert.match(
    prompt,
    /实际阅读并判断无需新增时自然说明结果即可/u
  );
  assert.match(prompt, /不要求固定话术、JSON 或维护工具调用/u);
}

function assertProtocolDelegatesPlacementToBackground(): void {
  // Both authoring prompt branches delegate placement to the actual shared
  // semantic task, rather than requiring the writer to keep rewriting prose.
  for (const prompt of [
    echoInkKnowledgeMaintenanceProtocolPrompt(),
    echoInkKnowledgeMaintenanceProtocolPrompt(emptyKnowledgeFolderBindings())
  ]) {
    const identity = prompt.indexOf("受控模型逐处判断是否同一概念并返回所有通过的提及");
    const position = prompt.indexOf("程序跨批按正文字符位置选择同一目标最早一处");
    assert.ok(identity >= 0 && position > identity,
      "concept classification precedes ordering all same-concept mentions by position");
    assert.match(prompt, /新增提及使用原词，不手工选择或插入新的知识链接/u);
    assert.match(prompt, /原有链接保持原写法/u);
    assert.match(prompt, /HTTP user agent 等不同含义/u);
    assert.match(prompt, /不要因为立即回读尚未出现首次链接而反复调用 knowledge_maintain 或重写正文/u);
    assert.match(prompt, /不能把正文写入成功声称为关联已完成/u);
  }
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
    if (blocked && blocked.reason !== "authorization_failed") assert.match(blocked.reason, /维护参数未通过：.*；请修正本次参数后重试。/u);
    return { security, toolCallId, blocked: blocked ? { ...blocked, reason: blocked.reason === "authorization_failed" ? blocked.reason : "tool_policy_blocked" } : undefined };
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
    request: "用户已确认初始化，请提炼本批来源。",
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
  })).blocked, undefined);
  assert.deepEqual((await authorize({
    name: "batch-outside",
    request: "请额外处理 raw/c.md",
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
  assert.equal(actionWithoutAssessment.blocked, undefined);
  assert.equal(await actionWithoutAssessment.security.handleToolCall({ toolName: "knowledge_maintain", toolCallId: "corrected-new-call", input: {} } as never, undefined), undefined);
  assert.deepEqual(actionWithoutAssessment.security.consume("corrected-new-call", {}).candidateActions, []);

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
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-reliable-noop-"));
  await fsp.mkdir(path.join(fixtureRoot, "vault/raw"), { recursive: true });
  await fsp.writeFile(path.join(fixtureRoot, "vault/raw/a.md"), "reliable raw");
  let indexCalls = 0;
  const domain = new Proxy({}, {
    get() {
      throw new Error("reliable noop must not access the Vault write domain");
    }
  });
  const port = new ProductionPiKnowledgeMaintenanceToolPort({
    vaultRootPath: path.join(fixtureRoot, "vault"),
    privateKnowledgeRootPath: path.join(fixtureRoot, "private"),
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
          rawContentRevision: `sha256:${sha256("reliable raw")}`,
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
    candidateActions: [],
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
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
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
  const domain = new FakeVaultDomain(vaultRootPath);
  let duringWrite: (() => Promise<void>) | undefined;
  try {
    await fsp.mkdir(path.join(vaultRootPath, "raw"), { recursive: true });
    await fsp.mkdir(path.join(vaultRootPath, "wiki"), { recursive: true });
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
      dateKey: () => DATE_KEY,
      faultInjector: async () => { const mutate = duringWrite; duringWrite = undefined; await mutate?.(); }
    });
    await port.initialize();
    const writesBeforeRejectedCandidate = domain.formalWrites.length;
    await fsp.writeFile(path.join(vaultRootPath, "raw/b.md"), "second source");
    const missingSources = await port.execute({
      vaultId: VAULT_ID, conversationId: "missing-sources", piSessionId: "missing-sources",
      productRunId: "missing-sources", toolCallId: "missing-sources", mode: "maintain", request: "",
      sourcePaths: [rawPath, "raw/b.md"], preferenceSnapshot: PREFERENCE,
      candidateActions: [{ targetPath: "wiki/missing-sources.md", content: "No source relation", expectedTarget: { kind: "missing" } }]
    });
    assert.equal(missingSources.status, "failed");
    assert.deepEqual(missingSources.maintenanceResult?.issues.map((issue) => issue.path), ["wiki/missing-sources.md"],
      "the all-candidates-rejected path must retain target identity for later correction");
    assert.equal(domain.formalWrites.length, writesBeforeRejectedCandidate);
    await fsp.rm(path.join(vaultRootPath, "raw/b.md"));
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
    assert.equal(rejectedCandidate.status, "completed", rejectedCandidate.message);
    assert.match(domain.content("wiki/missing-assessment.md") ?? "", /echoink-source/u);

    await fsp.mkdir(path.join(vaultRootPath, "wiki/人工智能（AI）"), { recursive: true });
    for (const [targetPath, reason] of [["wiki/english-only/note.md", "分类"]]) {
      const invalidFolder = await port.execute({
        vaultId: VAULT_ID, conversationId: "category-contract", piSessionId: "pi-category-contract",
        productRunId: `category-${reason}`, toolCallId: `category-${reason}`, mode: "maintain", request: "", sourcePaths: [rawPath], preferenceSnapshot: PREFERENCE,
        candidateActions: [{ targetPath, content: "not written", expectedTarget: {kind:"missing"} }],
        assessments: [{ claim: "fixture", status:"valid", evidence:[rawPath], asOf:DATE_KEY, verification:"unverified" }]
      });
      assert.equal(invalidFolder.status, "failed");
      assert.ok(invalidFolder.message.includes(reason), invalidFolder.message);
      assert.equal(domain.formalWrites.length, writesBeforeRejectedCandidate + 1);
    }
    const result = await port.execute({
      vaultId: VAULT_ID,
      conversationId: "conversation-production-noop",
      piSessionId: "pi-production-noop",
      productRunId: "run-production-noop",
      toolCallId: "tool-production-noop",
      sourceBodyFingerprints: { [rawPath]: rawDigestFingerprint(rawPath, Buffer.from(rawContent)) },
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
      false
    );
    assert.equal(domain.formalWrites.length, 1);
    const setRaw = async (value: string) => { await fsp.writeFile(path.join(vaultRootPath, rawPath), value); domain.seed(rawPath, value); };
    const executeCandidate = (id: string, content: string, fingerprints?: Readonly<Record<string, string>>) => port.execute({
      vaultId: VAULT_ID, conversationId: "tolerant-production", piSessionId: "pi-tolerant", productRunId: "same-run-corrections", toolCallId: id,
      mode: "maintain", request: "", sourcePaths: [rawPath], preferenceSnapshot: PREFERENCE, sourceBodyFingerprints: fingerprints,
      candidateActions: [{ targetPath: `wiki/${id}.md`, content, expectedTarget: { kind: "missing" } }]
    });
    duringWrite = () => setRaw(`---\ntags: [updated]\ncover: '![[missing-image.png]]'\n---\n${rawContent}`);
    const properties = await executeCandidate("properties", "正文不变时仍可提炼", { [rawPath]: rawDigestFingerprint(rawPath, Buffer.from(rawContent)) });
    assert.equal(properties.status, "completed", properties.message);
    const oldFingerprint = rawDigestFingerprint(rawPath, Buffer.from(rawContent));
    duringWrite = () => setRaw("正文已在执行中改成新的事实");
    const stale = await executeCandidate("during-change", "不能写入旧事实", { [rawPath]: oldFingerprint });
    assert.equal(stale.status, "failed");
    assert.match(stale.message, /已自动重读.*raw\/a.md/u);
    assert.match(stale.message, /正文已在执行中改成新的事实/u);
    assert.equal(domain.content("wiki/during-change.md"), undefined);
    const corrected = await executeCandidate("corrected-body", "依据新事实重新判断", stale.refreshedSources);
    assert.equal(corrected.status, "completed", corrected.message);
    const longBody = "长文有效事实。".repeat(8_000);
    await setRaw(`---\ntags: [long]\n---\n${longBody}`);
    const longRead = await executeCandidate("long-raw", "基于长文的已读部分", { [rawPath]: rawDigestFingerprint(rawPath, Buffer.from(longBody)) });
    assert.equal(longRead.status, "completed", longRead.message);
    await fsp.writeFile(path.join(vaultRootPath, "raw/b.md"), "第二篇当前正文");
    domain.seed("raw/b.md", "第二篇当前正文");
    const changedLong = await port.execute({ vaultId: VAULT_ID, conversationId: "tolerant-production", piSessionId: "pi-tolerant", productRunId: "same-run-corrections", toolCallId: "changed-long", mode: "maintain", request: "", preferenceSnapshot: PREFERENCE,
      sourcePaths: [rawPath, "raw/b.md"], sourceBodyFingerprints: { [rawPath]: oldFingerprint, "raw/b.md": oldFingerprint }, candidateActions: [] });
    assert.deepEqual(Object.keys(changedLong.refreshedSources ?? {}), [rawPath], "only the source actually sent in the bounded result is acknowledged");
    assert.ok(Buffer.byteLength(changedLong.message) < 8_000);
    assert.match(changedLong.message, /当前片段/u);
    const subset = await port.execute({
      vaultId: VAULT_ID, conversationId: "tolerant-production", piSessionId: "pi-tolerant", productRunId: "subset-run", toolCallId: "subset", mode: "maintain", request: "", preferenceSnapshot: PREFERENCE,
      sourcePaths: [rawPath, "raw/b.md"], sourceBodyFingerprints: { [rawPath]: rawDigestFingerprint(rawPath, Buffer.from(longBody)) },
      candidateActions: [{ targetPath: "wiki/subset.md", content: "仅采用 [[raw/a.md]] 的事实。", expectedTarget: { kind: "missing" } }]
    });
    assert.equal(subset.status, "completed", subset.message);
    assert.deepEqual(subset.processedSourcePaths, [rawPath]);
    assert.equal(domain.content(PHASE3_MAINTENANCE_TRACKER_PATH), trackerContent, "legacy tracker is retained without new writes");
    assert.equal(domain.content(phase3MaintenanceReportPath(DATE_KEY)), undefined);
    const { readPrivateMaintenanceRecords } = await import("../../plugin/pi-knowledge-maintenance-production");
    const records = await readPrivateMaintenanceRecords(privateKnowledgeRootPath);
    const detail = records.find((record) => record.recordId === subset.recordId)!;
    assert.equal(detail.sources.find((source) => source.path === "raw/b.md")?.status, "unread");
    assert.equal(detail.sources.find((source) => source.path === rawPath)?.status, "processed");
    assert.equal(detail.result.notes[0]?.path, "wiki/subset.md");
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
  const partial = await conflict.service.execute({
    vaultId: VAULT_ID, dateKey: DATE_KEY, preference: PREFERENCE, toolCall: toolCallFor("cas-conflict")
  });
  assert.equal(partial.status, "failed", "the conflicted knowledge note is never claimed as written");
  assert.equal(conflict.domain.formalWrites.includes("wiki/phase3-summary.md"), false);
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
    const denial = await security.handleToolCall({
      toolName: "knowledge_maintain", toolCallId: `invalid-expected-target-${index}`,
      input: { candidateActions: [action] }
    } as never, undefined);
    assert.equal(denial?.block, true);
    assert.match(denial?.reason ?? "", /维护参数未通过/u);
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

async function assertStaleUnwrittenWalDoesNotBlockCorrection(): Promise<void> {
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
  assert.equal(firstRecovery.blocked, 0);
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "completed");
  assert.deepEqual(fixture.domain.formalWrites, []);
  const corrected = await recoveredService.execute({ vaultId: VAULT_ID, dateKey: DATE_KEY, preference: PREFERENCE, toolCall: toolCallFor("corrected-next") });
  assert.equal(corrected.status, "completed");

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

async function assertRecoveredWalContinuesWithCurrentTargets():
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

  await assert.rejects(fixture.createService().execute({
    vaultId: VAULT_ID, dateKey: DATE_KEY, preference: PREFERENCE,
    toolCall: toolCallFor("stale-candidate-next")
  }), phase3Error("preview_stale"));
  assert.equal(proposalCall, 2, "recovery continues directly; the new candidate still must respect the current target");
  assert.equal(fixture.domain.content("wiki/phase3-summary.md"), recoveredKnowledge);
  assert.equal((await fixture.state.loadWal("preview-1"))?.status, "completed");

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
  constructor(private readonly diskRoot?: string) {}
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
    if (this.diskRoot) { await fsp.mkdir(path.dirname(path.join(this.diskRoot, input.relativePath)), { recursive: true }); await fsp.writeFile(path.join(this.diskRoot, input.relativePath), input.content); }
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
    if (this.diskRoot) { await fsp.mkdir(path.dirname(path.join(this.diskRoot, input.relativePath)), { recursive: true }); await fsp.writeFile(path.join(this.diskRoot, input.relativePath), input.content); }
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

async function assertPrivateRecordsRecoverWithoutRewriting(): Promise<void> {
  for (const failurePoint of ["before-private-record", "after-private-record"] as const) {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-private-record-")));
    const vault = path.join(root, "vault");
    const privateRoot = path.join(root, "private");
    await fsp.mkdir(path.join(vault, "阅读/来源"), { recursive: true });
    await fsp.mkdir(path.join(vault, "知识/卡片"), { recursive: true });
    const config = emptyKnowledgeFolderBindings();
    Object.assign(config.roles.raw, { enabled: true, readPaths: ["阅读/来源"], writePath: "阅读/来源" });
    Object.assign(config.roles.wiki, { enabled: true, readPaths: ["知识/卡片"], writePath: "知识/卡片" });
    const release = registerKnowledgeFolderBindings(vault, () => config);
    registerKnowledgePrivateRoot(vault, privateRoot);
    const domain = new FakeVaultDomain(vault);
    const source = "阅读/来源/a.md";
    await fsp.writeFile(path.join(vault, source), "原始版本");
    domain.seed(source, "原始版本");
    let fail = true;
    const options = { vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, dateKey: () => DATE_KEY };
    const input = { vaultId: VAULT_ID, conversationId: "private-record", piSessionId: "private-record", productRunId: "private-record", toolCallId: "save", mode: "maintain" as const, request: "", sourcePaths: [source], sourceBodyFingerprints: { [source]: rawDigestFingerprint(source, Buffer.from("原始版本")) }, preferenceSnapshot: PREFERENCE,
      candidateActions: [{ targetPath: "知识/卡片/a.md", content: "# 知识\n已理解的事实", expectedTarget: { kind: "missing" as const } }], assessments: [{ claim: "事实", status: "valid" as const, evidence: [source], asOf: DATE_KEY, verification: "unverified" as const }] };
    try {
      const port = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, faultInjector: (point) => { if (point === failurePoint && fail) { fail = false; throw new Error("record save failure"); } } });
      await port.initialize();
      const first = await port.execute(input);
      assert.equal(first.errorCode, "record_pending", first.message);
      assert.equal(first.maintenanceResult?.notes.length, 1);
      assert.equal(domain.formalWrites.length, 1);
      const restarted = new ProductionPiKnowledgeMaintenanceToolPort(options);
      await restarted.state.recoverPrivateFinalization();
      await restarted.initialize();
      const records = await readPrivateMaintenanceRecords(privateRoot);
      assert.equal(records.length, 1);
      assert.equal(records[0].result.assessments.length, 1);
      assert.equal(records[0].sources[0].status, "processed");
      const retry = await restarted.execute(input);
      assert.equal(retry.recordId, records[0].recordId);
      assert.deepEqual(retry.processedSourcePaths, [source], "recovered repeated calls retain processed sources");
      assert.equal(domain.formalWrites.length, 1, "recovery/repeated call never writes notes again");
      assert.deepEqual(await fsp.readdir(vault), ["知识", "阅读"], "only bound source and knowledge directories exist");
      // Global natural noop cannot process the current body from an older delivered fingerprint.
      await fsp.writeFile(path.join(vault, source), "新正文未被读取");
      domain.seed(source, "新正文未被读取");
      const stale = await restarted.execute({ ...input, productRunId: "global", toolCallId: "global", sourcePaths: [], candidateActions: [] });
      assert.equal(stale.errorCode, "preview_stale");
      const { readRawDigestRegistry } = await import("../../knowledge-base/raw-digest");
      const registry = await readRawDigestRegistry(vault, true);
      assert.notEqual(registry.entries[source].fingerprint, rawDigestFingerprint(source, Buffer.from("新正文未被读取")));
      // Read-only/no-candidate terminal bookkeeping still has a durable WAL.
      let terminalFail = true;
      const noop = new ProductionPiKnowledgeMaintenanceToolPort({ ...options, faultInjector: (point) => { if (point === "before-private-record" && terminalFail) { terminalFail = false; throw new Error("terminal record failure"); } }, knowledgeAgentIndex: { async readReliableKnowledgeForRaw() { return { rawPath: source, rawContentRevision: `sha256:${sha256("新正文未被读取")}`, entries: [{ vaultRelativePath: "知识/卡片/a.md", title: "知识", content: "现有知识", contentRevision: `sha256:${sha256("existing")}` }] }; } } as never });
      const terminal = await noop.execute({ ...input, productRunId: "reliable", toolCallId: "reliable", candidateActions: [], sourceBodyFingerprints: { [source]: rawDigestFingerprint(source, Buffer.from("新正文未被读取")) } });
      assert.equal(terminal.errorCode, "record_pending");
      await new ProductionPiKnowledgeMaintenanceToolPort(options).initialize();
      const afterTerminal = await readPrivateMaintenanceRecords(privateRoot);
      assert.equal(afterTerminal.filter((record) => record.runId === "reliable:reliable").length, 1);
      assert.equal(domain.formalWrites.length, 1);
    } finally { release(); await fsp.rm(root, { recursive: true, force: true }); }
  }
}

async function assertCorruptPrivateHistoryDoesNotBlockMaintenanceOrRetry(): Promise<void> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-corrupt-private-record-")));
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  const source = "阅读/来源/a.md", body = "本轮实际读取的来源正文\n";
  await fsp.mkdir(path.join(vault, "阅读/来源"), { recursive: true });
  await fsp.mkdir(path.join(vault, "知识/卡片"), { recursive: true });
  await fsp.writeFile(path.join(vault, source), body);
  const config = emptyKnowledgeFolderBindings();
  Object.assign(config.roles.raw, { enabled: true, readPaths: ["阅读/来源"], writePath: "阅读/来源" });
  Object.assign(config.roles.wiki, { enabled: true, readPaths: ["知识/卡片"], writePath: "知识/卡片" });
  const release = registerKnowledgeFolderBindings(vault, () => config);
  const domain = new FakeVaultDomain(vault); domain.seed(source, body);
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, dateKey: () => DATE_KEY });
  const input = { vaultId: VAULT_ID, conversationId: "corrupt-history", piSessionId: "corrupt-history", productRunId: "corrupt-history", toolCallId: "save", mode: "maintain" as const, request: "", sourcePaths: [source], sourceBodyFingerprints: { [source]: rawDigestFingerprint(source, Buffer.from(body)) }, preferenceSnapshot: PREFERENCE,
    candidateActions: [{ targetPath: "知识/卡片/a.md", content: `# Knowledge A\n来源：[[${source}]]`, expectedTarget: { kind: "missing" as const } }] };
  const warnings: unknown[][] = [], warn = console.warn;
  try {
    await port.initialize();
    const damagedNames = [`maintenance-${"f".repeat(32)}.json`, `maintenance-${"e".repeat(32)}.json`];
    await fsp.mkdir(path.join(privateRoot, "records"), { recursive: true });
    await fsp.writeFile(path.join(privateRoot, "records", damagedNames[0]), "{ broken JSON");
    await fsp.writeFile(path.join(privateRoot, "records", damagedNames[1]), JSON.stringify({ schemaVersion: 1, vaultId: VAULT_ID, kind: "record", payloadDigest: sha256("null"), payload: null }));
    console.warn = (...args) => { warnings.push(args); };
    const result = await port.execute(input);
    assert.equal(result.maintenanceResult?.status, "completed", result.message);
    assert.deepEqual(result.processedSourcePaths, [source], "unrelated corrupt records cannot block the post-write source read");
    const retry = await port.execute(input);
    assert.equal(retry.recordId, `maintenance-${sha256("corrupt-history:save").slice(0, 32)}`);
    assert.deepEqual(retry.processedSourcePaths, [source]);
    assert.equal(domain.formalWrites.length, 1, "a repeated call restores its own record without writing the note again");
    assert.equal(warnings.length, 0, "execution reads only its own stable record ID");
    const records = await readPrivateMaintenanceRecords(privateRoot, { vaultId: VAULT_ID });
    assert.deepEqual(records.map((record) => record.recordId), [retry.recordId]);
    assert.equal(warnings.length, 2, "history warns once per skipped corrupt JSON or payload");
    for (const name of damagedNames) assert(warnings.some((warning) => warning.includes(path.join(privateRoot, "records", name))));
    const invalidPaths: string[] = [];
    assert.equal((await readPrivateMaintenanceRecords(privateRoot, { vaultId: VAULT_ID, onInvalidRecord: (recordPath) => { invalidPaths.push(recordPath); } })).length, 1);
    assert.equal(invalidPaths.length, 2, "the history surface can combine invalid-record warnings into one notice");
  } finally { console.warn = warn; release(); await fsp.rm(root, { recursive: true, force: true }); }
}

async function assertFailedNaturalSettlementKeepsEverySourcePending(): Promise<void> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-failed-natural-settlement-")));
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  await fsp.mkdir(path.join(vault, "阅读/来源"), { recursive: true });
  const config = emptyKnowledgeFolderBindings();
  Object.assign(config.roles.raw, { enabled: true, readPaths: ["阅读/来源"], writePath: "阅读/来源" });
  const release = registerKnowledgeFolderBindings(vault, () => config);
  const a = "阅读/来源/read.md", b = "阅读/来源/unread.md", bodyA = "已读取且版本匹配\n", bodyB = "本轮未读取\n";
  await fsp.writeFile(path.join(vault, a), bodyA); await fsp.writeFile(path.join(vault, b), bodyB);
  const domain = new FakeVaultDomain(vault); domain.seed(a, bodyA); domain.seed(b, bodyB);
  const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: privateRoot });
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, dateKey: () => DATE_KEY });
  try {
    await port.initialize();
    const read = await index.read({ vaultRelativePath: a });
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "note_read", isError: false, details: { references: [{ vaultRelativePath: a, contentRevision: read.contentRevision }], sourceBodyFingerprints: { [a]: rawDigestFingerprint(a, Buffer.from(bodyA)) } } } }] as never;
    assert.equal((await readRawDigestRegistry(vault, true)).entries[a], undefined);
    const settlement = await port.finalizeNatural({ vaultId: VAULT_ID, conversationId: "failed-natural", piSessionId: "failed-natural", productRunId: "failed-natural", scope: { mode: "batch", sourcePaths: [a, b] }, terminalState: "failed", noteReadPaths: [a], producedPaths: [], assistantEntryId: "assistant", entries, turnEntries: entries });
    assert.deepEqual(settlement.processedSourcePaths, []);
    assert.deepEqual(settlement.pendingSourcePaths, [a, b]);
    const record = (await readPrivateMaintenanceRecords(privateRoot)).find((record) => record.runId === "failed-natural:natural")!;
    assert.equal(record.result.status, "failed", "failed turns still finalize a private record");
    assert.deepEqual(record.sources.map((source) => ({ path: source.path, status: source.status })), [{ path: a, status: "failed" }, { path: b, status: "unread" }]);
    assert.equal(record.sources[0].fingerprint, rawDigestFingerprint(a, Buffer.from(bodyA)), "a matching read fingerprint does not mark a failed turn processed");
    const registry = await readRawDigestRegistry(vault, true);
    assert.equal(registry.entries[a], undefined);
    assert.equal(registry.entries[b], undefined, "failed finalization never advances either source's processed registry entry");
    assert.equal(domain.formalWrites.length, 0);
  } finally { release(); await fsp.rm(root, { recursive: true, force: true }); }
}

async function assertPrivateSettlementBoundaries(): Promise<void> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-private-boundaries-")));
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  await fsp.mkdir(path.join(vault, "阅读/来源"), { recursive: true });
  await fsp.mkdir(path.join(vault, "知识/卡片"), { recursive: true });
  const config = emptyKnowledgeFolderBindings();
  Object.assign(config.roles.raw, { enabled: true, readPaths: ["阅读/来源"], writePath: "阅读/来源" });
  Object.assign(config.roles.wiki, { enabled: true, readPaths: ["知识/卡片"], writePath: "知识/卡片" });
  const release = registerKnowledgeFolderBindings(vault, () => config); registerKnowledgePrivateRoot(vault, privateRoot);
  const domain = new FakeVaultDomain(vault);
  const a = "阅读/来源/a.md", b = "阅读/来源/b.md";
  const bodyA = "---\ntitle: Frontmatter source\n---\n\n规范正文 A\n", bodyB = "规范正文 B\n";
  const revisionA = rawDigestFingerprint(a, Buffer.from(bodyA)), revisionB = rawDigestFingerprint(b, Buffer.from(bodyB));
  await fsp.writeFile(path.join(vault, a), bodyA); await fsp.writeFile(path.join(vault, b), bodyB); domain.seed(a, bodyA); domain.seed(b, bodyB);
  const index = new KnowledgeAgentIndex({ vaultPath: vault, storageRootPath: privateRoot });
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, knowledgeAgentIndex: index, dateKey: () => DATE_KEY });
  const base = { vaultId: VAULT_ID, conversationId: "boundaries", piSessionId: "boundaries", mode: "maintain" as const, request: "", preferenceSnapshot: PREFERENCE };
  const call = (id: string) => ({ ...base, productRunId: id, toolCallId: id });
  try {
    await port.initialize();
    const seed = await port.execute({ ...call("seed"), sourcePaths: [a], sourceBodyFingerprints: { [a]: revisionA }, candidateActions: [{ targetPath: "知识/卡片/a.md", content: `# Knowledge A\n来源：[[${a}]]`, expectedTarget: { kind: "missing" } }] });
    assert.equal(seed.maintenanceResult?.status, "completed", seed.message); index.invalidate();
    const writes = domain.formalWrites.length;
    for (const global of [false, true]) for (const outdated of [false, true]) {
      const registry = await readRawDigestRegistry(vault, true); delete registry.entries[a]; await writeRawDigestRegistry(vault, registry);
      const id = `reliable-${global}-${outdated}`;
      const result = await port.execute({ ...call(id), ...(global ? { sourcePaths: [], globalSourcePaths: [a] } : { sourcePaths: [a] }), candidateActions: [], ...(outdated ? { sourceBodyFingerprints: { [a]: `sha256:1:${"f".repeat(64)}` } } : {}) });
      assert.equal(result.maintenanceResult?.status, "noop", result.message);
      assert.equal((await readRawDigestRegistry(vault, true)).entries[a].fingerprint, revisionA, "reliable knowledge establishes the normalized current body fingerprint");
      assert.equal((await discoverKnowledgeBaseSources(vault, {})).changedSources.some(source => source.relativePath === a), false);
      const record = (await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === `${id}:${id}`)!;
      assert.equal(record.sources[0].status, "processed"); assert.equal(record.sources[0].fingerprint, revisionA);
    }
    assert.equal(domain.formalWrites.length, writes, "reliable noop does not write notes in any scope/fingerprint combination");
    const racedPort = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never, knowledgeAgentIndex: { async readReliableKnowledgeForRaw(relative) { const proof = await index.readReliableKnowledgeForRaw(relative); await fsp.writeFile(path.join(vault, a), bodyA + "Changed after proof\n"); return proof; } }, dateKey: () => DATE_KEY });
    const raced = await racedPort.execute({ ...call("proof-race"), sourcePaths: [], globalSourcePaths: [a], candidateActions: [] });
    assert.equal(raced.errorCode, "preview_stale");
    assert.equal((await readRawDigestRegistry(vault, true)).entries[a].fingerprint, revisionA, "a concurrent body change cannot advance the processed version");
    await fsp.writeFile(path.join(vault, a), bodyA); index.invalidate(a);
    await fsp.writeFile(path.join(vault, "知识/卡片/conflict.md"), "keep existing"); domain.seed("知识/卡片/conflict.md", "keep existing");
    const independent = await port.execute({ ...call("independent"), sourcePaths: [a, b], sourceBodyFingerprints: { [a]: revisionA, [b]: revisionB }, candidateActions: [
      { targetPath: "知识/卡片/independent.md", content: `# A result\n[[${a}]]`, expectedTarget: { kind: "missing" } },
      { targetPath: "知识/卡片/conflict.md", content: `# B result\n[[${b}]]`, expectedTarget: { kind: "missing" } }
    ] });
    assert.equal(independent.maintenanceResult?.status, "partial", independent.message);
    const independentRecord = (await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === "independent:independent")!;
    assert.equal(independentRecord.sources.find(source => source.path === a)?.status, "processed");
    assert.notEqual(independentRecord.sources.find(source => source.path === b)?.status, "processed");
    const same = await port.execute({ ...call("same-source"), sourcePaths: [a], sourceBodyFingerprints: { [a]: revisionA }, candidateActions: [
      { targetPath: "知识/卡片/same.md", content: `# A result\n[[${a}]]`, expectedTarget: { kind: "missing" } },
      { targetPath: "知识/卡片/conflict.md", content: `# A failed\n[[${a}]]`, expectedTarget: { kind: "missing" } }
    ] });
    assert.equal(same.maintenanceResult?.status, "partial");
    assert.notEqual((await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === "same-source:same-source")!.sources[0].status, "processed", "one failed candidate keeps its entire source pending");
    const disallowed = await port.execute({ ...call("unapproved-child"), sourcePaths: [a], sourceBodyFingerprints: { [a]: revisionA }, candidateActions: [{ targetPath: "知识/卡片/unapproved/note.md", content: `# A\n[[${a}]]`, expectedTarget: { kind: "missing" } }] });
    assert.equal(disallowed.status, "failed"); assert.equal(await fsp.stat(path.join(vault, "知识/卡片/unapproved")).catch(() => null), null);
    index.invalidate();
    const references = await Promise.all([a, b].map(async vaultRelativePath => ({ vaultRelativePath, contentRevision: (await index.read({ vaultRelativePath })).contentRevision })));
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "note_read", isError: false, details: { references, sourceBodyFingerprints: { [a]: revisionA, [b]: revisionB } } } }] as never;
    await port.finalizeNatural({ ...base, productRunId: "natural-query", scope: { mode: "query", candidatePaths: [a] }, terminalState: "completed", noteReadPaths: [a, b], producedPaths: [], assistantEntryId: "assistant", entries, turnEntries: entries });
    const natural = (await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === "natural-query:natural")!;
    assert.deepEqual(natural.sources.map(source => source.path), [a]); assert.equal(natural.sources[0].status, "processed");
    await port.finalizeNatural({ ...base, productRunId: "empty-global", scope: { mode: "global", sourcePaths: [] }, terminalState: "completed", noteReadPaths: [b], producedPaths: [], assistantEntryId: "assistant", entries, turnEntries: entries });
    assert.deepEqual((await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === "empty-global:natural")!.sources, []);
    const externalEntries = [{ type: "message", message: { role: "toolResult", toolName: "external_read", isError: false, details: { references } } }] as never;
    await port.finalizeNatural({ ...base, productRunId: "external-empty", scope: { mode: "global", sourcePaths: [] }, terminalState: "completed", noteReadPaths: [], producedPaths: [], assistantEntryId: "assistant", entries: externalEntries, turnEntries: externalEntries });
    assert.deepEqual((await readPrivateMaintenanceRecords(privateRoot)).find(record => record.runId === "external-empty:natural")!.sources, []);
    assert.equal(await fsp.readFile(path.join(vault, a), "utf8"), bodyA, "all bookkeeping leaves the original Raw bytes unchanged");
  } finally { release(); await fsp.rm(root, { recursive: true, force: true }); }
}

async function assertOriginalV1WalNeverRevivesRetiredFiles(): Promise<void> {
  // Fixed JSON was emitted by the e0d1829 original service and its original fixture.
  const original = JSON.parse(await fsp.readFile("src/tests/fixtures/knowledge-maintenance/v1-prepared-wal.json", "utf8")) as Phase3MaintenanceWalRecord;
  assert.equal(original.version, 1);
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-v1-wal-")));
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  await fsp.mkdir(vault); const domain = new FakeVaultDomain(vault);
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "user", deviceId: "device", domainService: domain as never });
  try {
    await port.state.createWal(original); await port.initialize();
    assert.equal(domain.formalWrites.length, 0);
    assert.deepEqual(await fsp.readdir(vault), [], "old candidates and retired runtime files are never recreated");
    const record = (await readPrivateMaintenanceRecords(privateRoot))[0];
    assert(record.sources.every(source => source.status !== "processed"));
    assert.equal((await port.state.loadWal(original.preview.previewId))?.status, "completed");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}
