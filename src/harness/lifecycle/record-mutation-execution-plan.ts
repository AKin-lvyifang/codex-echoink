import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  assertDurableDirectoryStat,
  durableAppendOnlyChainPath,
  durableLstatOrNull,
  DurableAppendOnlyCasError,
  publishDurableAppendOnlyChain,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  validateDurableRelativePath,
  type DurableAppendOnlyFaultPoint,
  type DurableAppendOnlyLayout
} from "../storage/durable-append-only-cas";
import type { WorkflowArtifactKind } from "../contracts/run-record";
import {
  parseRecordMutationIntent,
  RECORD_MUTATION_MAX_PARTICIPANTS,
  recordMutationDigest,
  stableRecordMutationStringify,
  type RecordMutationIntent,
  type RecordMutationOperation,
  type RecordMutationParticipant,
  type RecordMutationParticipantAction,
  type RecordMutationRecordKind
} from "./record-mutation-contract";
import type { LoadedRecordMutationJournal } from "./record-mutation-journal";

const EXECUTION_PLAN_SCHEMA_VERSION = 2 as const;
const EXECUTION_PLAN_NAMESPACE = "record-mutation-execution-plans";
const EXECUTION_PLAN_ENTRY = "plan.json";
const EXECUTION_PLAN_TOKEN_PATTERN = /^plan-[a-f0-9]{24}$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_EXECUTION_PLAN_BYTES = 8 * 1024 * 1024;
export const RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS = 16_384;
const ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
  "markdown-report",
  "ui-card",
  "tracker",
  "history",
  "wiki",
  "editor-change",
  "other"
]);

export type RecordMutationMemorySubjectState =
  | "formal"
  | "confirmation";

export type RecordMutationExecutionSubject =
  | {
      kind: "workflow-run";
      workflowRunId: string;
      attemptId: string;
      harnessRunId: string;
      payloadDigest: string;
    }
  | {
      kind: "memory";
      memoryId: string;
      state: RecordMutationMemorySubjectState;
    }
  | {
      kind: "artifact";
      artifactId: string;
      artifactKind: WorkflowArtifactKind;
    };

export interface RecordMutationExecutionTrashBundleItem {
  itemId: string;
  sourceRelativePath: string;
}

export type RecordMutationExecutionRetainSubject =
  | {
      kind: "workflow-run-summary";
      workflowRunId: string;
      summaryDigest: string;
    }
  | {
      kind: "attempt-run-summary";
      workflowRunId: string;
      attemptId: string;
      summaryDigest: string;
    }
  | {
      kind: "attempt-payload-expired";
      workflowRunId: string;
      attemptId: string;
      tombstoneDigest: string;
    }
  | {
      kind: "attempt-payload-not-captured";
      workflowRunId: string;
      attemptId: string;
      reasonCode:
        | "failed-before-payload"
        | "capture-disabled"
        | "no-attempt-required";
    }
  | {
      kind: "raw";
      rawRef: string;
      sourceRelativePath: string;
      ownersDigest: string;
    };

export type RecordMutationExecutionBundle =
  | {
      kind: "retain-bundle";
      rootId: string;
      selectionDigest: string;
      subjects: RecordMutationExecutionRetainSubject[];
    }
  | {
      kind: "trash-bundle";
      sourceRootId: string;
      trashRootId: string;
      selectionDigest: string;
      items: RecordMutationExecutionTrashBundleItem[];
    }
  | {
      kind: "source-deletion-bundle";
      rootId: string;
      selectionDigest: string;
      subjects: RecordMutationExecutionSubject[];
    };

export type RecordMutationExecutionParticipant =
  | {
      participantId: string;
      recordKind: RecordMutationRecordKind;
      action: "retain";
      execution: { kind: "retain" };
    }
  | {
      participantId: string;
      recordKind: Extract<
        RecordMutationRecordKind,
        "conversation" | "workflow-run" | "raw"
      >;
      action: Extract<RecordMutationParticipantAction, "stage" | "discard">;
      execution: {
        kind: "trash";
        sourceRootId: string;
        trashRootId: string;
        sourceRelativePath: string;
      };
    }
  | {
      participantId: string;
      recordKind: Extract<
        RecordMutationRecordKind,
        "workflow-run" | "memory" | "artifact"
      >;
      action: "mark-source-deleted";
      execution: {
        kind: "source-deletion";
        rootId: string;
        subject: RecordMutationExecutionSubject;
      };
    }
  | {
      participantId: string;
      recordKind: RecordMutationRecordKind;
      action: "retain";
      execution: Extract<
        RecordMutationExecutionBundle,
        { kind: "retain-bundle" }
      >;
    }
  | {
      participantId: string;
      recordKind: Extract<
        RecordMutationRecordKind,
        "conversation" | "workflow-run" | "raw"
      >;
      action: Extract<RecordMutationParticipantAction, "stage" | "discard">;
      execution: Extract<
        RecordMutationExecutionBundle,
        { kind: "trash-bundle" }
      >;
    }
  | {
      participantId: string;
      recordKind: Extract<
        RecordMutationRecordKind,
        "workflow-run" | "memory" | "artifact"
      >;
      action: "mark-source-deleted";
      execution: Extract<
        RecordMutationExecutionBundle,
        { kind: "source-deletion-bundle" }
      >;
    };

export interface RecordMutationExecutionPlanV2 {
  schemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  kind: "record-mutation-execution-plan";
  mutationId: string;
  operation: Extract<
    RecordMutationOperation,
    "clear-conversation-records" | "delete-conversation"
  >;
  conversationId: string;
  intentDigest: string;
  participants: RecordMutationExecutionParticipant[];
  createdAt: number;
  digest: string;
}

export interface RecordMutationExecutionPlanHandle {
  storageRootPath: string;
  namespaceRootPath: string;
  stagingRootPath: string;
  chainToken: string;
  chainRootPath: string;
  planPath: string;
  mutationId: string;
}

export interface LoadedRecordMutationExecutionPlan {
  handle: RecordMutationExecutionPlanHandle;
  plan: RecordMutationExecutionPlanV2;
}

export type RecordMutationExecutionPlanErrorCode =
  | "invalid_plan"
  | "plan_missing"
  | "plan_conflict"
  | "journal_mismatch"
  | "unsafe_entry";

export class RecordMutationExecutionPlanError extends Error {
  constructor(
    public readonly code: RecordMutationExecutionPlanErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationExecutionPlanError";
  }
}

export function workflowRunPayloadParticipantId(
  workflowRunIdInput: string,
  attemptIdInput: string
): string {
  const workflowRunId = requireSafeId(
    workflowRunIdInput,
    "workflowRunId"
  );
  const attemptId = requireSafeId(attemptIdInput, "attemptId");
  const digest = recordMutationDigest({
    kind: "workflow-run-payload-participant",
    workflowRunId,
    attemptId
  });
  return `run-payload-${digest.slice("sha256:".length, 31)}`;
}

export function recordMutationExecutionBundleParticipantId(input: {
  recordKind: RecordMutationRecordKind;
  action: RecordMutationParticipantAction;
  execution: RecordMutationExecutionBundle;
}): string {
  const digest = recordMutationDigest({
    kind: "record-mutation-execution-bundle-participant",
    recordKind: input.recordKind,
    action: input.action,
    execution: input.execution
  });
  return `bundle-${input.recordKind}-${digest.slice("sha256:".length, 31)}`;
}

export async function createRecordMutationExecutionPlan(input: {
  journal: LoadedRecordMutationJournal;
  participants: readonly RecordMutationExecutionParticipant[];
  createdAt: number;
  faultInjector?: (
    point: DurableAppendOnlyFaultPoint
  ) => void | Promise<void>;
}): Promise<LoadedRecordMutationExecutionPlan> {
  const layout = await requireLayout(
    input.journal.handle.storageRootPath,
    true
  );
  const candidate = createPlanCandidate(input);
  const handle = planHandle(layout, candidate.mutationId);
  const existing = await loadPlanFromHandle(handle);
  if (existing) {
    validateRecordMutationExecutionPlanAgainstJournal(
      existing.plan,
      input.journal
    );
    if (!sameExecutionPlanIdentity(existing.plan, candidate)) {
      throw planConflict(
        `RecordMutation ${candidate.mutationId} execution plan 已存在且内容冲突`
      );
    }
    return existing;
  }
  if (input.journal.record.state !== "planned") {
    throw journalMismatch(
      "RecordMutation execution plan 必须在第一个 Journal stage 前耐久发布"
    );
  }

  try {
    await publishDurableAppendOnlyChain(
      layout,
      handle.chainToken,
      EXECUTION_PLAN_ENTRY,
      planBytes(candidate),
      {
        maxBytes: MAX_EXECUTION_PLAN_BYTES,
        faultInjector: input.faultInjector
      }
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw mapExecutionPlanError(error);
  }

  const published = await loadPlanFromHandle(handle);
  if (!published) {
    throw new RecordMutationExecutionPlanError(
      "plan_missing",
      "RecordMutation execution plan publish 后缺失"
    );
  }
  validateRecordMutationExecutionPlanAgainstJournal(
    published.plan,
    input.journal
  );
  if (!sameExecutionPlanIdentity(published.plan, candidate)) {
    throw planConflict(
      `RecordMutation ${candidate.mutationId} execution plan publish winner 冲突`
    );
  }
  return published;
}

export async function loadRecordMutationExecutionPlan(input: {
  storageRootPath: string;
  mutationId: string;
  journal?: LoadedRecordMutationJournal;
}): Promise<LoadedRecordMutationExecutionPlan | null> {
  try {
    const layout = await resolveDurableAppendOnlyLayout(
      input.storageRootPath,
      EXECUTION_PLAN_NAMESPACE,
      false
    );
    if (!layout) return null;
    const loaded = await loadPlanFromHandle(
      planHandle(layout, requireSafeId(input.mutationId, "mutationId"))
    );
    if (loaded && input.journal) {
      if (
        path.resolve(loaded.handle.storageRootPath)
        !== path.resolve(input.journal.handle.storageRootPath)
      ) {
        throw journalMismatch(
          "execution plan 与 Journal storage root 不匹配"
        );
      }
      validateRecordMutationExecutionPlanAgainstJournal(
        loaded.plan,
        input.journal
      );
    }
    return loaded;
  } catch (error) {
    throw mapExecutionPlanError(error);
  }
}

export function parseRecordMutationExecutionPlan(
  value: unknown
): RecordMutationExecutionPlanV2 {
  const record = requirePlainRecord(value, "execution plan");
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_EXECUTION_PLAN_BYTES) {
    throw invalidPlan("execution plan 超过大小上限");
  }
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "mutationId",
    "operation",
    "conversationId",
    "intentDigest",
    "participants",
    "createdAt",
    "digest"
  ], "execution plan");
  if (record.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION) {
    throw invalidPlan(
      `execution plan schema 不受支持：${String(record.schemaVersion)}`
    );
  }
  if (record.kind !== "record-mutation-execution-plan") {
    throw invalidPlan("execution plan kind 非法");
  }
  if (
    record.operation !== "clear-conversation-records"
    && record.operation !== "delete-conversation"
  ) {
    throw invalidPlan("execution plan operation 必须是破坏性操作");
  }
  if (
    !Array.isArray(record.participants)
    || record.participants.length < 1
    || record.participants.length > RECORD_MUTATION_MAX_PARTICIPANTS
  ) {
    throw invalidPlan("execution plan participants 数量非法");
  }
  const participants = record.participants.map(
    (participant, index) => parseExecutionParticipant(participant, index)
  );
  const participantIds = participants.map(
    (participant) => participant.participantId
  );
  if (
    new Set(participantIds).size !== participantIds.length
    || participantIds.some(
      (participantId, index) =>
        participantId
        !== [...participantIds].sort(compareText)[index]
    )
  ) {
    throw invalidPlan("execution plan participants 必须唯一且按 id 排序");
  }
  const parsed: RecordMutationExecutionPlanV2 = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    kind: "record-mutation-execution-plan",
    mutationId: requireSafeId(record.mutationId, "mutationId"),
    operation: record.operation,
    conversationId: requireSafeId(record.conversationId, "conversationId"),
    intentDigest: requireDigest(record.intentDigest, "intentDigest"),
    participants,
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    digest: requireDigest(record.digest, "digest")
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (parsed.digest !== recordMutationDigest(withoutDigest)) {
    throw invalidPlan("execution plan digest 不匹配");
  }
  return parsed;
}

export function validateRecordMutationExecutionPlanAgainstJournal(
  planInput: unknown,
  journal: LoadedRecordMutationJournal
): RecordMutationExecutionPlanV2 {
  const plan = parseRecordMutationExecutionPlan(planInput);
  const intent = parseRecordMutationIntent(journal.record.intent);
  assertDestructiveIntent(intent);
  if (
    plan.mutationId !== journal.record.mutationId
    || plan.operation !== intent.operation
    || plan.conversationId !== intent.conversationId
    || plan.intentDigest !== journal.record.intentDigest
  ) {
    throw journalMismatch(
      "execution plan 与 RecordMutation Journal identity/intent 不匹配"
    );
  }
  if (plan.createdAt < journal.chain[0].createdAt) {
    throw journalMismatch(
      "execution plan createdAt 早于 RecordMutation Journal"
    );
  }
  if (
    plan.participants.length !== intent.participants.length
    || plan.participants.some((participant, index) => (
      !sameParticipantIdentity(participant, intent.participants[index])
    ))
  ) {
    throw journalMismatch(
      "execution plan participants 与 intent 不完整同序"
    );
  }

  const rootBindingIds = intent.rootBindings.map((binding) => binding.rootId);
  const rootBindingSet = new Set(rootBindingIds);
  const usedRootIds = new Set<string>();
  const bundleSelectionDigests = new Set<string>();
  const bundleGroups = new Set<string>();
  for (const participant of plan.participants) {
    if (participant.execution.kind === "retain") {
      continue;
    }
    if ("selectionDigest" in participant.execution) {
      bundleSelectionDigests.add(participant.execution.selectionDigest);
      const groupKey = recordMutationBundleGroupKey(participant);
      if (bundleGroups.has(groupKey)) {
        throw journalMismatch(
          `execution plan bundle group 重复：${groupKey}`
        );
      }
      bundleGroups.add(groupKey);
    }
    if (participant.execution.kind === "retain-bundle") {
      requireIntentRoot(
        rootBindingSet,
        participant.execution.rootId,
        participant.participantId
      );
      usedRootIds.add(participant.execution.rootId);
      assertRetainSubjectsMatchParticipant(
        participant.participantId,
        participant.recordKind,
        participant.execution.subjects
      );
      continue;
    }
    if (
      participant.execution.kind === "trash"
      || participant.execution.kind === "trash-bundle"
    ) {
      if (participant.execution.sourceRootId === participant.execution.trashRootId) {
        throw journalMismatch(
          `participant ${participant.participantId} source/trash root 不能相同`
        );
      }
      requireIntentRoot(
        rootBindingSet,
        participant.execution.sourceRootId,
        participant.participantId
      );
      requireIntentRoot(
        rootBindingSet,
        participant.execution.trashRootId,
        participant.participantId
      );
      usedRootIds.add(participant.execution.sourceRootId);
      usedRootIds.add(participant.execution.trashRootId);
      continue;
    }
    requireIntentRoot(
      rootBindingSet,
      participant.execution.rootId,
      participant.participantId
    );
    usedRootIds.add(participant.execution.rootId);
    assertSubjectMatchesParticipant(participant);
  }
  if (bundleSelectionDigests.size > 1) {
    throw journalMismatch(
      "execution plan bundle selection digest 必须完整一致"
    );
  }
  assertWorkflowRunBundleCoverage(plan.participants);
  const used = [...usedRootIds].sort(compareText);
  const frozen = [...rootBindingIds].sort(compareText);
  if (stableRecordMutationStringify(used) !== stableRecordMutationStringify(frozen)) {
    throw journalMismatch(
      "execution plan 必须精确使用 intent 冻结的全部 Root Binding"
    );
  }
  return plan;
}

function createPlanCandidate(input: {
  journal: LoadedRecordMutationJournal;
  participants: readonly RecordMutationExecutionParticipant[];
  createdAt: number;
}): RecordMutationExecutionPlanV2 {
  const intent = parseRecordMutationIntent(input.journal.record.intent);
  assertDestructiveIntent(intent);
  const draft = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    kind: "record-mutation-execution-plan" as const,
    mutationId: input.journal.record.mutationId,
    operation: intent.operation,
    conversationId: intent.conversationId,
    intentDigest: input.journal.record.intentDigest,
    participants: input.participants.map(
      (participant) => structuredClone(participant)
    ),
    createdAt: requireTimestamp(input.createdAt, "createdAt")
  };
  const plan = parseRecordMutationExecutionPlan({
    ...draft,
    digest: recordMutationDigest(draft)
  });
  return validateRecordMutationExecutionPlanAgainstJournal(
    plan,
    input.journal
  );
}

async function loadPlanFromHandle(
  handle: RecordMutationExecutionPlanHandle
): Promise<LoadedRecordMutationExecutionPlan | null> {
  const chain = await durableLstatOrNull(handle.chainRootPath);
  if (!chain) return null;
  assertDurableDirectoryStat(chain, "RecordMutation execution plan chain");
  const entries = await fsp.readdir(handle.chainRootPath, {
    withFileTypes: true
  });
  if (
    entries.length !== 1
    || entries[0]?.name !== EXECUTION_PLAN_ENTRY
    || !entries[0].isFile()
    || entries[0].isSymbolicLink()
  ) {
    throw unsafeEntry("RecordMutation execution plan chain 含未知 entry");
  }
  const readback = await readDurableRegularFile(
    handle.planPath,
    MAX_EXECUTION_PLAN_BYTES
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readback.content.toString("utf8")) as unknown;
  } catch {
    throw invalidPlan("RecordMutation execution plan JSON 损坏");
  }
  const plan = parseRecordMutationExecutionPlan(parsed);
  if (
    plan.mutationId !== handle.mutationId
    || executionPlanToken(plan.mutationId) !== handle.chainToken
  ) {
    throw unsafeEntry("RecordMutation execution plan path identity 不匹配");
  }
  return { handle, plan };
}

function planHandle(
  layout: DurableAppendOnlyLayout,
  mutationId: string
): RecordMutationExecutionPlanHandle {
  const normalizedMutationId = requireSafeId(mutationId, "mutationId");
  const chainToken = executionPlanToken(normalizedMutationId);
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  return {
    storageRootPath: layout.storageRootPath,
    namespaceRootPath: layout.namespaceRootPath,
    stagingRootPath: layout.stagingRootPath,
    chainToken,
    chainRootPath,
    planPath: path.join(chainRootPath, EXECUTION_PLAN_ENTRY),
    mutationId: normalizedMutationId
  };
}

async function requireLayout(
  storageRootPath: string,
  create: boolean
): Promise<DurableAppendOnlyLayout> {
  try {
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      EXECUTION_PLAN_NAMESPACE,
      create
    );
    if (!layout) {
      throw new RecordMutationExecutionPlanError(
        "plan_missing",
        "RecordMutation execution plan namespace 不存在"
      );
    }
    return layout;
  } catch (error) {
    throw mapExecutionPlanError(error);
  }
}

function parseExecutionParticipant(
  value: unknown,
  index: number
): RecordMutationExecutionParticipant {
  const record = requirePlainRecord(value, `participants[${index}]`);
  assertExactKeys(
    record,
    ["participantId", "recordKind", "action", "execution"],
    `participants[${index}]`
  );
  const participantId = requireSafeId(
    record.participantId,
    `participants[${index}].participantId`
  );
  const recordKind = requireRecordKind(
    record.recordKind,
    `participants[${index}].recordKind`
  );
  const execution = requirePlainRecord(
    record.execution,
    `participants[${index}].execution`
  );
  if (record.action === "retain") {
    if (execution.kind === "retain-bundle") {
      const bundle = parseRetainBundleExecution(execution, index);
      assertBundleParticipantIdentity(
        participantId,
        recordKind,
        "retain",
        bundle
      );
      return {
        participantId,
        recordKind,
        action: "retain",
        execution: bundle
      };
    }
    assertExactKeys(execution, ["kind"], `participants[${index}].execution`);
    if (execution.kind !== "retain") {
      throw invalidPlan(`participants[${index}] retain execution 非法`);
    }
    return {
      participantId,
      recordKind,
      action: "retain",
      execution: { kind: "retain" }
    };
  }
  if (record.action === "stage" || record.action === "discard") {
    if (
      recordKind !== "conversation"
      && recordKind !== "workflow-run"
      && recordKind !== "raw"
    ) {
      throw invalidPlan(
        `participants[${index}] trash recordKind 非法`
      );
    }
    if (execution.kind === "trash-bundle") {
      const bundle = parseTrashBundleExecution(execution, index);
      assertBundleParticipantIdentity(
        participantId,
        recordKind,
        record.action,
        bundle
      );
      return {
        participantId,
        recordKind,
        action: record.action,
        execution: bundle
      };
    }
    assertExactKeys(
      execution,
      ["kind", "sourceRootId", "trashRootId", "sourceRelativePath"],
      `participants[${index}].execution`
    );
    if (execution.kind !== "trash") {
      throw invalidPlan(`participants[${index}] trash execution 非法`);
    }
    let sourceRelativePath: string;
    try {
      sourceRelativePath = validateDurableRelativePath(
        execution.sourceRelativePath as string
      );
    } catch {
      throw invalidPlan(
        `participants[${index}].sourceRelativePath 非法`
      );
    }
    return {
      participantId,
      recordKind,
      action: record.action,
      execution: {
        kind: "trash",
        sourceRootId: requireSafeId(
          execution.sourceRootId,
          `participants[${index}].sourceRootId`
        ),
        trashRootId: requireSafeId(
          execution.trashRootId,
          `participants[${index}].trashRootId`
        ),
        sourceRelativePath
      }
    };
  }
  if (record.action === "mark-source-deleted") {
    if (
      recordKind !== "workflow-run"
      && recordKind !== "memory"
      && recordKind !== "artifact"
    ) {
      throw invalidPlan(
        `participants[${index}] source-deletion recordKind 非法`
      );
    }
    if (execution.kind === "source-deletion-bundle") {
      const bundle = parseSourceDeletionBundleExecution(
        execution,
        index,
        recordKind
      );
      assertBundleParticipantIdentity(
        participantId,
        recordKind,
        "mark-source-deleted",
        bundle
      );
      return {
        participantId,
        recordKind,
        action: "mark-source-deleted",
        execution: bundle
      };
    }
    assertExactKeys(
      execution,
      ["kind", "rootId", "subject"],
      `participants[${index}].execution`
    );
    if (execution.kind !== "source-deletion") {
      throw invalidPlan(
        `participants[${index}] source-deletion execution 非法`
      );
    }
    return {
      participantId,
      recordKind,
      action: "mark-source-deleted",
      execution: {
        kind: "source-deletion",
        rootId: requireSafeId(
          execution.rootId,
          `participants[${index}].rootId`
        ),
        subject: parseExecutionSubject(
          execution.subject,
          index
        )
      }
    };
  }
  throw invalidPlan(`participants[${index}].action 非法`);
}

function parseExecutionSubject(
  value: unknown,
  participantIndex: number
): RecordMutationExecutionSubject {
  const subject = requirePlainRecord(
    value,
    `participants[${participantIndex}].subject`
  );
  if (subject.kind === "workflow-run") {
    assertExactKeys(
      subject,
      [
        "kind",
        "workflowRunId",
        "attemptId",
        "harnessRunId",
        "payloadDigest"
      ],
      `participants[${participantIndex}].subject`
    );
    return {
      kind: "workflow-run",
      workflowRunId: requireSafeId(
        subject.workflowRunId,
        `participants[${participantIndex}].subject.workflowRunId`
      ),
      attemptId: requireSafeId(
        subject.attemptId,
        `participants[${participantIndex}].subject.attemptId`
      ),
      harnessRunId: requireSafeId(
        subject.harnessRunId,
        `participants[${participantIndex}].subject.harnessRunId`
      ),
      payloadDigest: requireDigest(
        subject.payloadDigest,
        `participants[${participantIndex}].subject.payloadDigest`
      )
    };
  }
  if (subject.kind === "memory") {
    assertExactKeys(
      subject,
      ["kind", "memoryId", "state"],
      `participants[${participantIndex}].subject`
    );
    if (subject.state !== "formal" && subject.state !== "confirmation") {
      throw invalidPlan(
        `participants[${participantIndex}].subject.state 非法`
      );
    }
    return {
      kind: "memory",
      memoryId: requireSafeId(
        subject.memoryId,
        `participants[${participantIndex}].subject.memoryId`
      ),
      state: subject.state
    };
  }
  if (subject.kind === "artifact") {
    assertExactKeys(
      subject,
      ["kind", "artifactId", "artifactKind"],
      `participants[${participantIndex}].subject`
    );
    if (
      typeof subject.artifactKind !== "string"
      || !ARTIFACT_KINDS.has(subject.artifactKind as WorkflowArtifactKind)
    ) {
      throw invalidPlan(
        `participants[${participantIndex}].subject.artifactKind 非法`
      );
    }
    return {
      kind: "artifact",
      artifactId: requireSafeId(
        subject.artifactId,
        `participants[${participantIndex}].subject.artifactId`
      ),
      artifactKind: subject.artifactKind as WorkflowArtifactKind
    };
  }
  throw invalidPlan(
    `participants[${participantIndex}].subject.kind 非法`
  );
}

function parseRetainBundleExecution(
  execution: Record<string, unknown>,
  participantIndex: number
): Extract<RecordMutationExecutionBundle, { kind: "retain-bundle" }> {
  assertExactKeys(
    execution,
    ["kind", "rootId", "selectionDigest", "subjects"],
    `participants[${participantIndex}].execution`
  );
  if (
    execution.kind !== "retain-bundle"
    || !Array.isArray(execution.subjects)
    || execution.subjects.length < 1
    || execution.subjects.length > RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] retain bundle 非法`
    );
  }
  const subjects = execution.subjects.map((subject, subjectIndex) => (
    parseRetainSubject(subject, participantIndex, subjectIndex)
  ));
  const subjectKeys = subjects.map((subject) => (
    stableRecordMutationStringify(subject)
  ));
  if (
    new Set(subjectKeys).size !== subjects.length
    || subjectKeys.some(
      (subjectKey, index) =>
        subjectKey !== [...subjectKeys].sort(compareText)[index]
    )
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] retain bundle subjects 必须唯一且稳定排序`
    );
  }
  return {
    kind: "retain-bundle",
    rootId: requireSafeId(
      execution.rootId,
      `participants[${participantIndex}].rootId`
    ),
    selectionDigest: requireDigest(
      execution.selectionDigest,
      `participants[${participantIndex}].selectionDigest`
    ),
    subjects
  };
}

function parseTrashBundleExecution(
  execution: Record<string, unknown>,
  participantIndex: number
): Extract<RecordMutationExecutionBundle, { kind: "trash-bundle" }> {
  assertExactKeys(
    execution,
    [
      "kind",
      "sourceRootId",
      "trashRootId",
      "selectionDigest",
      "items"
    ],
    `participants[${participantIndex}].execution`
  );
  if (execution.kind !== "trash-bundle") {
    throw invalidPlan(
      `participants[${participantIndex}] trash bundle kind 非法`
    );
  }
  if (
    !Array.isArray(execution.items)
    || execution.items.length < 1
    || execution.items.length > RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] trash bundle items 数量非法`
    );
  }
  const items = execution.items.map((value, itemIndex) => {
    const item = requirePlainRecord(
      value,
      `participants[${participantIndex}].items[${itemIndex}]`
    );
    assertExactKeys(
      item,
      ["itemId", "sourceRelativePath"],
      `participants[${participantIndex}].items[${itemIndex}]`
    );
    let sourceRelativePath: string;
    try {
      sourceRelativePath = validateDurableRelativePath(
        item.sourceRelativePath as string
      );
    } catch {
      throw invalidPlan(
        `participants[${participantIndex}].items[${itemIndex}].sourceRelativePath 非法`
      );
    }
    return {
      itemId: requireSafeId(
        item.itemId,
        `participants[${participantIndex}].items[${itemIndex}].itemId`
      ),
      sourceRelativePath
    };
  });
  const itemKeys = items.map((item) => (
    `${item.itemId}\0${item.sourceRelativePath}`
  ));
  const sourcePaths = items.map((item) => item.sourceRelativePath);
  const sortedItemKeys = [...itemKeys].sort(compareText);
  const sourcePathSet = new Set(sourcePaths);
  const hasNestedSourcePath = sourcePaths.some((sourcePath) => {
    const segments = sourcePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (sourcePathSet.has(segments.slice(0, index).join("/"))) {
        return true;
      }
    }
    return false;
  });
  if (
    new Set(items.map((item) => item.itemId)).size !== items.length
    || new Set(sourcePaths).size !== sourcePaths.length
    || itemKeys.some((itemKey, index) => itemKey !== sortedItemKeys[index])
    || hasNestedSourcePath
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] trash bundle items`
      + " 必须唯一、稳定排序且路径不嵌套"
    );
  }
  return {
    kind: "trash-bundle",
    sourceRootId: requireSafeId(
      execution.sourceRootId,
      `participants[${participantIndex}].sourceRootId`
    ),
    trashRootId: requireSafeId(
      execution.trashRootId,
      `participants[${participantIndex}].trashRootId`
    ),
    selectionDigest: requireDigest(
      execution.selectionDigest,
      `participants[${participantIndex}].selectionDigest`
    ),
    items
  };
}

function parseSourceDeletionBundleExecution(
  execution: Record<string, unknown>,
  participantIndex: number,
  recordKind: Extract<
    RecordMutationRecordKind,
    "workflow-run" | "memory" | "artifact"
  >
): Extract<
  RecordMutationExecutionBundle,
  { kind: "source-deletion-bundle" }
> {
  assertExactKeys(
    execution,
    ["kind", "rootId", "selectionDigest", "subjects"],
    `participants[${participantIndex}].execution`
  );
  if (
    execution.kind !== "source-deletion-bundle"
    || !Array.isArray(execution.subjects)
    || execution.subjects.length < 1
    || execution.subjects.length > RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] source-deletion bundle 非法`
    );
  }
  const subjects = execution.subjects.map((subject) => (
    parseExecutionSubject(subject, participantIndex)
  ));
  if (
    subjects.some((subject) => subject.kind !== recordKind)
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] source-deletion bundle subject kind 不匹配`
    );
  }
  const subjectKeys = subjects.map((subject) => (
    stableRecordMutationStringify(subject)
  ));
  if (
    new Set(subjectKeys).size !== subjectKeys.length
    || subjectKeys.some(
      (subjectKey, index) =>
        subjectKey !== [...subjectKeys].sort(compareText)[index]
    )
  ) {
    throw invalidPlan(
      `participants[${participantIndex}] source-deletion bundle subjects 必须唯一且稳定排序`
    );
  }
  return {
    kind: "source-deletion-bundle",
    rootId: requireSafeId(
      execution.rootId,
      `participants[${participantIndex}].rootId`
    ),
    selectionDigest: requireDigest(
      execution.selectionDigest,
      `participants[${participantIndex}].selectionDigest`
    ),
    subjects
  };
}

function parseRetainSubject(
  value: unknown,
  participantIndex: number,
  subjectIndex: number
): RecordMutationExecutionRetainSubject {
  const label =
    `participants[${participantIndex}].subjects[${subjectIndex}]`;
  const subject = requirePlainRecord(value, label);
  if (subject.kind === "workflow-run-summary") {
    assertExactKeys(
      subject,
      ["kind", "workflowRunId", "summaryDigest"],
      label
    );
    return {
      kind: "workflow-run-summary",
      workflowRunId: requireSafeId(
        subject.workflowRunId,
        `${label}.workflowRunId`
      ),
      summaryDigest: requireDigest(
        subject.summaryDigest,
        `${label}.summaryDigest`
      )
    };
  }
  if (subject.kind === "attempt-run-summary") {
    assertExactKeys(
      subject,
      ["kind", "workflowRunId", "attemptId", "summaryDigest"],
      label
    );
    return {
      kind: "attempt-run-summary",
      workflowRunId: requireSafeId(
        subject.workflowRunId,
        `${label}.workflowRunId`
      ),
      attemptId: requireSafeId(
        subject.attemptId,
        `${label}.attemptId`
      ),
      summaryDigest: requireDigest(
        subject.summaryDigest,
        `${label}.summaryDigest`
      )
    };
  }
  if (subject.kind === "attempt-payload-expired") {
    assertExactKeys(
      subject,
      ["kind", "workflowRunId", "attemptId", "tombstoneDigest"],
      label
    );
    return {
      kind: "attempt-payload-expired",
      workflowRunId: requireSafeId(
        subject.workflowRunId,
        `${label}.workflowRunId`
      ),
      attemptId: requireSafeId(
        subject.attemptId,
        `${label}.attemptId`
      ),
      tombstoneDigest: requireDigest(
        subject.tombstoneDigest,
        `${label}.tombstoneDigest`
      )
    };
  }
  if (subject.kind === "attempt-payload-not-captured") {
    assertExactKeys(
      subject,
      ["kind", "workflowRunId", "attemptId", "reasonCode"],
      label
    );
    if (
      subject.reasonCode !== "failed-before-payload"
      && subject.reasonCode !== "capture-disabled"
      && subject.reasonCode !== "no-attempt-required"
    ) {
      throw invalidPlan(`${label}.reasonCode 非法`);
    }
    return {
      kind: "attempt-payload-not-captured",
      workflowRunId: requireSafeId(
        subject.workflowRunId,
        `${label}.workflowRunId`
      ),
      attemptId: requireSafeId(
        subject.attemptId,
        `${label}.attemptId`
      ),
      reasonCode: subject.reasonCode
    };
  }
  if (subject.kind === "raw") {
    assertExactKeys(
      subject,
      [
        "kind",
        "rawRef",
        "sourceRelativePath",
        "ownersDigest"
      ],
      label
    );
    let rawRef: string;
    let sourceRelativePath: string;
    try {
      rawRef = validateDurableRelativePath(subject.rawRef as string);
      sourceRelativePath = validateDurableRelativePath(
        subject.sourceRelativePath as string
      );
    } catch {
      throw invalidPlan(`${label} Raw path 非法`);
    }
    if (
      !rawRef.startsWith("raw/")
      || rawRef === "raw/"
    ) {
      throw invalidPlan(`${label}.rawRef 非法`);
    }
    return {
      kind: "raw",
      rawRef,
      sourceRelativePath,
      ownersDigest: requireDigest(
        subject.ownersDigest,
        `${label}.ownersDigest`
      )
    };
  }
  throw invalidPlan(`${label}.kind 非法`);
}

function assertBundleParticipantIdentity(
  participantId: string,
  recordKind: RecordMutationRecordKind,
  action: RecordMutationParticipantAction,
  execution: RecordMutationExecutionBundle
): void {
  const expected = recordMutationExecutionBundleParticipantId({
    recordKind,
    action,
    execution
  });
  if (participantId !== expected) {
    throw invalidPlan(
      `participant ${participantId} bundle identity 不匹配`
    );
  }
}

function assertDestructiveIntent(
  intent: RecordMutationIntent
): asserts intent is RecordMutationIntent & {
  operation: "clear-conversation-records" | "delete-conversation";
} {
  if (
    intent.operation !== "clear-conversation-records"
    && intent.operation !== "delete-conversation"
  ) {
    throw journalMismatch(
      "RecordMutation execution plan 仅用于破坏性操作"
    );
  }
}

function sameParticipantIdentity(
  plan: RecordMutationExecutionParticipant,
  intent: RecordMutationParticipant | undefined
): boolean {
  return Boolean(
    intent
    && plan.participantId === intent.id
    && plan.recordKind === intent.recordKind
    && plan.action === intent.action
  );
}

function recordMutationBundleGroupKey(
  participant: RecordMutationExecutionParticipant
): string {
  const execution = participant.execution;
  if (execution.kind === "retain-bundle") {
    return stableRecordMutationStringify([
      participant.recordKind,
      participant.action,
      execution.rootId
    ]);
  }
  if (execution.kind === "trash-bundle") {
    return stableRecordMutationStringify([
      participant.recordKind,
      participant.action,
      execution.sourceRootId,
      execution.trashRootId
    ]);
  }
  if (execution.kind === "source-deletion-bundle") {
    return stableRecordMutationStringify([
      participant.recordKind,
      participant.action,
      execution.rootId
    ]);
  }
  throw journalMismatch(
    `participant ${participant.participantId} 不是 bundle`
  );
}

function assertWorkflowRunBundleCoverage(
  participants: readonly RecordMutationExecutionParticipant[]
): void {
  const sourceLeafIds: string[] = [];
  const trashLeafIds: string[] = [];
  for (const participant of participants) {
    if (
      participant.recordKind === "workflow-run"
      && participant.execution.kind === "source-deletion-bundle"
    ) {
      for (const subject of participant.execution.subjects) {
        if (subject.kind !== "workflow-run") {
          throw journalMismatch(
            `participant ${participant.participantId} Run subject 非法`
          );
        }
        sourceLeafIds.push(
          workflowRunPayloadParticipantId(
            subject.workflowRunId,
            subject.attemptId
          )
        );
      }
      continue;
    }
    if (
      participant.recordKind === "workflow-run"
      && participant.action === "discard"
      && participant.execution.kind === "trash-bundle"
    ) {
      trashLeafIds.push(
        ...participant.execution.items.map((item) => item.itemId)
      );
    }
  }
  if (!sourceLeafIds.length && !trashLeafIds.length) return;
  const source = [...sourceLeafIds].sort(compareText);
  const trash = [...trashLeafIds].sort(compareText);
  if (
    new Set(source).size !== source.length
    || new Set(trash).size !== trash.length
    || stableRecordMutationStringify(source)
      !== stableRecordMutationStringify(trash)
  ) {
    throw journalMismatch(
      "Workflow Run source-deletion 与 Trash bundle 叶子覆盖不一致"
    );
  }
}

function assertRetainSubjectsMatchParticipant(
  participantId: string,
  recordKind: RecordMutationRecordKind,
  subjects: readonly RecordMutationExecutionRetainSubject[]
): void {
  const valid = subjects.every((subject) => (
    recordKind === "workflow-run"
      ? subject.kind !== "raw"
      : recordKind === "raw" && subject.kind === "raw"
  ));
  if (!valid) {
    throw journalMismatch(
      `participant ${participantId} retain subject kind 不匹配`
    );
  }
}

function assertSubjectMatchesParticipant(
  participant: RecordMutationExecutionParticipant
): void {
  if (
    participant.action === "mark-source-deleted"
    && participant.execution.kind === "source-deletion-bundle"
  ) {
    assertBundleParticipantIdentity(
      participant.participantId,
      participant.recordKind,
      participant.action,
      participant.execution
    );
    return;
  }
  if (
    participant.action !== "mark-source-deleted"
    || participant.execution.kind !== "source-deletion"
  ) {
    throw journalMismatch(
      `participant ${participant.participantId} source-deletion execution 缺失`
    );
  }
  const subject = participant.execution.subject;
  const matches = participant.recordKind === "workflow-run"
    ? subject.kind === "workflow-run"
      && workflowRunPayloadParticipantId(
        subject.workflowRunId,
        subject.attemptId
      ) === participant.participantId
    : participant.recordKind === "memory"
      ? subject.kind === "memory"
        && subject.memoryId === participant.participantId
      : subject.kind === "artifact"
        && subject.artifactId === participant.participantId;
  if (!matches) {
    throw journalMismatch(
      `participant ${participant.participantId} subject identity 不匹配`
    );
  }
}

function requireIntentRoot(
  rootBindingIds: ReadonlySet<string>,
  rootId: string,
  participantId: string
): void {
  if (!rootBindingIds.has(rootId)) {
    throw journalMismatch(
      `participant ${participantId} 引用了 intent 外 Root Binding：${rootId}`
    );
  }
}

function sameExecutionPlanIdentity(
  left: RecordMutationExecutionPlanV2,
  right: RecordMutationExecutionPlanV2
): boolean {
  return stableRecordMutationStringify({
    mutationId: left.mutationId,
    operation: left.operation,
    conversationId: left.conversationId,
    intentDigest: left.intentDigest,
    participants: left.participants
  }) === stableRecordMutationStringify({
    mutationId: right.mutationId,
    operation: right.operation,
    conversationId: right.conversationId,
    intentDigest: right.intentDigest,
    participants: right.participants
  });
}

function executionPlanToken(mutationId: string): string {
  const token = `plan-${createHash("sha256")
    .update(Buffer.from(mutationId, "utf8"))
    .digest("hex")
    .slice(0, 24)}`;
  if (!EXECUTION_PLAN_TOKEN_PATTERN.test(token)) {
    throw invalidPlan("execution plan token 非法");
  }
  return token;
}

function planBytes(plan: RecordMutationExecutionPlanV2): Buffer {
  const bytes = Buffer.from(
    `${stableRecordMutationStringify(plan)}\n`,
    "utf8"
  );
  if (bytes.byteLength > MAX_EXECUTION_PLAN_BYTES) {
    throw invalidPlan("execution plan 超过大小上限");
  }
  return bytes;
}

function requireRecordKind(
  value: unknown,
  label: string
): RecordMutationRecordKind {
  if (
    value !== "conversation"
    && value !== "workflow-run"
    && value !== "raw"
    && value !== "memory"
    && value !== "artifact"
  ) {
    throw invalidPlan(`${label} 非法`);
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw invalidPlan(`${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidPlan(`${label} 非法`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidPlan(`${label} 非法`);
  }
  return Number(value);
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPlan(`${label} 不是对象`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidPlan(`${label} 不是 plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidPlan(`${label} 字段集合非法`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof DurableAppendOnlyCasError
    && error.code === "already_exists";
}

function mapExecutionPlanError(
  error: unknown
): RecordMutationExecutionPlanError {
  if (error instanceof RecordMutationExecutionPlanError) return error;
  if (error instanceof DurableAppendOnlyCasError) {
    if (error.code === "missing") {
      return new RecordMutationExecutionPlanError(
        "plan_missing",
        error.message
      );
    }
    return unsafeEntry(error.message);
  }
  return invalidPlan(error instanceof Error ? error.message : String(error));
}

function invalidPlan(message: string): RecordMutationExecutionPlanError {
  return new RecordMutationExecutionPlanError("invalid_plan", message);
}

function planConflict(message: string): RecordMutationExecutionPlanError {
  return new RecordMutationExecutionPlanError("plan_conflict", message);
}

function journalMismatch(message: string): RecordMutationExecutionPlanError {
  return new RecordMutationExecutionPlanError("journal_mismatch", message);
}

function unsafeEntry(message: string): RecordMutationExecutionPlanError {
  return new RecordMutationExecutionPlanError("unsafe_entry", message);
}
