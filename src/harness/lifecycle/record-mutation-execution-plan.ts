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
  recordMutationDigest,
  stableRecordMutationStringify,
  type RecordMutationIntent,
  type RecordMutationOperation,
  type RecordMutationParticipant,
  type RecordMutationParticipantAction,
  type RecordMutationRecordKind
} from "./record-mutation-contract";
import type { LoadedRecordMutationJournal } from "./record-mutation-journal";

const EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;
const EXECUTION_PLAN_NAMESPACE = "record-mutation-execution-plans";
const EXECUTION_PLAN_ENTRY = "plan.json";
const EXECUTION_PLAN_TOKEN_PATTERN = /^plan-[a-f0-9]{24}$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_EXECUTION_PLAN_BYTES = 1024 * 1024;
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
    };

export interface RecordMutationExecutionPlanV1 {
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
  plan: RecordMutationExecutionPlanV1;
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
): RecordMutationExecutionPlanV1 {
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
    || record.participants.length > 32
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
  const parsed: RecordMutationExecutionPlanV1 = {
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
): RecordMutationExecutionPlanV1 {
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
  for (const participant of plan.participants) {
    if (participant.execution.kind === "retain") continue;
    if (participant.execution.kind === "trash") {
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
}): RecordMutationExecutionPlanV1 {
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

function assertSubjectMatchesParticipant(
  participant: RecordMutationExecutionParticipant
): void {
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
  left: RecordMutationExecutionPlanV1,
  right: RecordMutationExecutionPlanV1
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

function planBytes(plan: RecordMutationExecutionPlanV1): Buffer {
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
