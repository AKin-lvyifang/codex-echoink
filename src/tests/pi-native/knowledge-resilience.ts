import assert from "node:assert/strict";
import type { PiKnowledgeReference } from "../../harness/pi-native/contracts";
import { PiKnowledgeReadToolSecurity } from "../../harness/pi-native/pi-knowledge-read-tools";
import { PI_KNOWLEDGE_VERIFICATION_ENTRY_TYPE, knowledgeVerificationFromSessionEntry } from "../../harness/pi-native/pi-knowledge-verification";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { KnowledgeAgentIndex } from "../../knowledge-base/knowledge-agent-index";
import { KnowledgeRetriever } from "../../knowledge-base/query";
import { createProductionPiKnowledgeRuntime } from "../../plugin/pi-production-runtime-composition";

const identity = Object.freeze({ vaultId: "resilience-v", conversationId: "resilience-c", piSessionId: "resilience-s", productRunId: "resilience-r" });
const references: readonly Readonly<PiKnowledgeReference>[] = Object.freeze([Object.freeze({
  referenceId: "ref-resilience", vaultRelativePath: "wiki/source.md", title: "Source", excerpt: "Delivered source",
  contentRevision: `sha256:${"a".repeat(64)}`, lineStart: 1, lineEnd: 1, sourceType: "wiki" as const,
  verificationStatus: "local_revision_verified" as const
})]);

export async function runPiKnowledgeResilienceTests(): Promise<void> {
  const failures: unknown[] = [];
  for (const [name, run] of [
    ["lazy tool authorization", lazyToolAuthorization],
    ["invalid and denied tools", invalidAndDeniedTools],
    ["one-shot authorization during preparation", oneShotAuthorizationDuringPreparation],
    ["empty-reference verification", emptyReferenceVerification],
    ["revoked-permission verification", revokedPermissionVerification],
    ["verification error propagation", verificationErrorPropagation],
    ["allowed verification freshness", allowedVerificationFreshness],
    ["verification record parsing", verificationRecordParsing]
  ] as const) {
    try { await run(); console.log(`Knowledge resilience: ${name} PASS`); }
    catch (error) { console.error(`Knowledge resilience: ${name} FAIL`, error); failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Knowledge resilience regressions");
}

async function lazyToolAuthorization(): Promise<void> {
  for (const toolName of ["knowledge_search", "knowledge_read"] as const) {
    let workflow: "none" | "chat" = "none";
    const order: string[] = [];
    const security = new PiKnowledgeReadToolSecurity({
      currentWorkflow: () => workflow,
      currentRunIdentity: () => { order.push("identity"); return identity; },
      prepareWorkflow: async (name, args) => {
        assert.equal(name, toolName);
        assert.ok(Object.isFrozen(args));
        order.push("allowed");
        workflow = "chat";
        order.push("workflow");
      },
      egress: new EchoInkVaultToolEgressPolicy()
    });
    const args = toolName === "knowledge_search" ? { query: "source" }
      : { vaultRelativePath: "wiki/source.md", expectedContentRevision: references[0].contentRevision };
    const event = { toolName, toolCallId: `first-${toolName}`, input: args } as never;
    assert.equal(await security.handleToolCall(event, undefined), undefined, "a valid first tool must prepare chat before checking the workflow");
    assert.deepEqual(order, ["allowed", "workflow", "identity"]);
    assert.deepEqual(security.consume(`first-${toolName}`, toolName, args).identity, identity);
    assert.deepEqual(await security.handleToolCall(event, undefined), { block: true, reason: "authorization_failed" });
  }
}

async function invalidAndDeniedTools(): Promise<void> {
  let prepared = 0;
  let initialized = 0;
  const security = new PiKnowledgeReadToolSecurity({
    currentWorkflow: () => "none", currentRunIdentity: () => identity,
    prepareWorkflow: async () => { prepared++; await Promise.reject(new Error("agent_capability_knowledge_denied")); initialized++; },
    egress: new EchoInkVaultToolEgressPolicy()
  });
  for (const [toolName, input] of [["knowledge_search", {}], ["knowledge_search", { query: "x", extra: true }],
    ["knowledge_read", { vaultRelativePath: "wiki/source.md", expectedContentRevision: "invalid" }]] as const) {
    assert.ok(await security.handleToolCall({ toolName, input, toolCallId: `invalid-${prepared}` } as never, undefined));
  }
  assert.equal(prepared, 0, "malformed requests must not check capabilities or initialize a workflow");
  assert.ok(await security.handleToolCall({ toolName: "knowledge_search", input: { query: "x" }, toolCallId: "denied" } as never, undefined));
  assert.equal(prepared, 1);
  assert.equal(initialized, 0);
  const absent = new PiKnowledgeReadToolSecurity({ currentWorkflow: () => "none", currentRunIdentity: () => identity, egress: new EchoInkVaultToolEgressPolicy() });
  assert.deepEqual(await absent.handleToolCall({ toolName: "knowledge_search", input: { query: "x" }, toolCallId: "absent" } as never, undefined),
    { block: true, reason: "authorization_failed" }, "no callback cannot grant a workflow");
}

async function oneShotAuthorizationDuringPreparation(): Promise<void> {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let prepared = 0;
  let workflow: "none" | "chat" = "none";
  const security = new PiKnowledgeReadToolSecurity({
    currentRunIdentity: () => identity, currentWorkflow: () => workflow,
    prepareWorkflow: async () => { prepared++; await pending; workflow = "chat"; },
    egress: new EchoInkVaultToolEgressPolicy()
  });
  const event = { toolName: "knowledge_search", input: { query: "source" }, toolCallId: "concurrent-replay" } as never;
  const first = security.handleToolCall(event, undefined);
  const replay = await security.handleToolCall(event, undefined);
  release();
  assert.equal(await first, undefined);
  assert.deepEqual(replay, { block: true, reason: "authorization_failed" });
  assert.equal(prepared, 1, "an in-flight tool ID must not prepare or authorize twice");
}

function verificationRuntime(isConversationKnowledgeAllowed?: () => Promise<boolean>) {
  const root = "/synthetic-knowledge-resilience";
  return createProductionPiKnowledgeRuntime({ vaultRootPath: root,
    knowledgeAgentIndex: new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: `${root}/state` }),
    knowledgePreferences: {} as never, usage: {} as never, isConversationKnowledgeAllowed });
}

async function emptyReferenceVerification(): Promise<void> {
  let permissionChecks = 0;
  const runtime = verificationRuntime(async () => { permissionChecks++; throw new Error("permission-store-unavailable"); });
  assert.deepEqual(await runtime.verifyAskReferences({ ...identity, references: [] }), { status: "valid", references: [] });
  assert.equal(permissionChecks, 0, "an empty reference list cannot require current Knowledge permission");
}

async function revokedPermissionVerification(): Promise<void> {
  const original = KnowledgeRetriever.prototype.verifyReferences;
  let reads = 0;
  KnowledgeRetriever.prototype.verifyReferences = async () => { reads++; throw new Error("source must remain unread after revocation"); };
  try {
    const runtime = verificationRuntime(async () => false);
    const result = await runtime.verifyAskReferences({ ...identity, references });
    assert.equal(result.status, "verification_skipped");
    assert.ok(result.status === "verification_skipped");
    assert.equal(result.reason, "knowledge_permission_revoked");
    assert.equal(result.references, references, "retain the exact delivered snapshots after revocation");
    assert.equal(result.references[0].verificationStatus, "local_revision_verified");
    assert.equal(reads, 0);
  } finally { KnowledgeRetriever.prototype.verifyReferences = original; }
}

async function verificationErrorPropagation(): Promise<void> {
  const permissionError = new Error("permission-store-corrupt");
  await assert.rejects(verificationRuntime(async () => { throw permissionError; }).verifyAskReferences({ ...identity, references }), error => error === permissionError);
  const original = KnowledgeRetriever.prototype.verifyReferences;
  const sourceError = new Error("source-io-failed");
  KnowledgeRetriever.prototype.verifyReferences = async () => { throw sourceError; };
  try {
    for (const runtime of [verificationRuntime(async () => true), verificationRuntime()]) {
      await assert.rejects(runtime.verifyAskReferences({ ...identity, references }), error => error === sourceError);
    }
  } finally { KnowledgeRetriever.prototype.verifyReferences = original; }
}

async function allowedVerificationFreshness(): Promise<void> {
  const original = KnowledgeRetriever.prototype.verifyReferences;
  let reads = 0;
  KnowledgeRetriever.prototype.verifyReferences = async input => {
    reads++;
    return { status: "source_changed", references: [], fixedResponse: "来源已变化，请重新执行", changedReferenceIds: input.map(reference => reference.referenceId) };
  };
  try {
    const result = await verificationRuntime(async () => true).verifyAskReferences({ ...identity, references });
    assert.equal(result.status, "valid");
    assert.ok(result.status === "valid");
    assert.equal(result.references[0].verificationStatus, "source_link_changed");
    assert.equal(references[0].verificationStatus, "local_revision_verified", "freshness annotation cannot mutate the delivered snapshot");
    assert.equal(reads, 1);
  } finally { KnowledgeRetriever.prototype.verifyReferences = original; }
}

async function verificationRecordParsing(): Promise<void> {
  const data = { schemaVersion: 1, piSessionId: identity.piSessionId, productRunId: identity.productRunId,
    assistantEntryId: "assistant-resilience", reason: "knowledge_permission_revoked", referenceIds: [references[0].referenceId] };
  const entry = { type: "custom", customType: PI_KNOWLEDGE_VERIFICATION_ENTRY_TYPE, data };
  const record = knowledgeVerificationFromSessionEntry(entry, identity.piSessionId);
  assert.deepEqual(record, data);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record!.referenceIds));
  data.referenceIds.push("later-untrusted-mutation");
  assert.deepEqual(record!.referenceIds, [references[0].referenceId]);
  for (const candidate of [null, [], { ...entry, type: "message" }, { ...entry, customType: "other.v1" }, { ...entry, data: null },
    ...[{ schemaVersion: 2 }, { piSessionId: "other-session" }, { productRunId: " " }, { assistantEntryId: "" },
      { reason: "source_io_failed" }, { referenceIds: [] }, { referenceIds: [""] }, { referenceIds: [123] }, { referenceIds: "ref" }]
      .map(patch => ({ ...entry, data: { ...data, ...patch } }))]) {
    assert.equal(knowledgeVerificationFromSessionEntry(candidate, identity.piSessionId), null);
  }
  assert.equal(knowledgeVerificationFromSessionEntry(entry, ""), null);
}
