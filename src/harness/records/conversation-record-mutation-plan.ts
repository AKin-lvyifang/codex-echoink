import {
  parseRecordMutationIntent,
  recordMutationDigest,
  stableRecordMutationStringify,
  type RecordMutationConversationTarget,
  type RecordMutationIntent
} from "../lifecycle/record-mutation-contract";
import {
  RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS,
  recordMutationExecutionBundleParticipantId,
  workflowRunPayloadParticipantId,
  type RecordMutationExecutionBundle,
  type RecordMutationExecutionParticipant,
  type RecordMutationExecutionRetainSubject,
  type RecordMutationExecutionSubject
} from "../lifecycle/record-mutation-execution-plan";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  type EchoInkRecordMutationRootId
} from "../lifecycle/record-mutation-production";
import {
  validateDurableRelativePath
} from "../storage/durable-append-only-cas";
import type {
  RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  isSafeConversationSessionId
} from "../conversation/storage-contract";
import type {
  ConversationRecordMutationSource
} from "../conversation/conversation-store";
import type {
  ConversationRecordInventory
} from "./conversation-record-inventory";

export interface BuildConversationRecordMutationPlanInput {
  inventory: ConversationRecordInventory;
  conversationSources: readonly ConversationRecordMutationSource[];
  expectedConversationGeneration: number;
  expectedConversationCommitId: string;
  expectedConversationContentRevision: string;
  targetConversation: RecordMutationConversationTarget;
  rootBindings: readonly RecordRootBindingRef[];
  conversationRootId?: EchoInkRecordMutationRootId;
}

export interface BuiltConversationRecordMutationPlan {
  intent: RecordMutationIntent;
  executionParticipants: RecordMutationExecutionParticipant[];
  requiredRootIds: EchoInkRecordMutationRootId[];
  selectionDigest: string;
  leafRecordCount: number;
}

export type ConversationRecordMutationPlanErrorCode =
  | "inventory_blocked"
  | "source_invalid"
  | "root_mismatch"
  | "capacity_exceeded";

export class ConversationRecordMutationPlanError extends Error {
  constructor(
    public readonly code: ConversationRecordMutationPlanErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationRecordMutationPlanError";
  }
}

/**
 * Derives the complete logical Root set before any physical Root registration.
 * The final builder reuses the same function, so live callers cannot register
 * a guessed subset that later drifts from the immutable execution plan.
 */
export function conversationRecordMutationRequiredRootIds(
  inventoryInput: ConversationRecordInventory,
  conversationRootId: EchoInkRecordMutationRootId =
    ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
): EchoInkRecordMutationRootId[] {
  const inventory = requireReadyInventory(inventoryInput);
  const requiredRootIds = new Set<EchoInkRecordMutationRootId>([
    conversationRootId,
    ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
  ]);
  if (inventory.run.workflowRuns.length) {
    requiredRootIds.add(ECHOINK_RECORD_MUTATION_ROOT_IDS.run);
  }
  if (inventory.raw.subjects.length) {
    requiredRootIds.add(ECHOINK_RECORD_MUTATION_ROOT_IDS.raw);
  }
  if (inventory.memory.subjects.length) {
    requiredRootIds.add(ECHOINK_RECORD_MUTATION_ROOT_IDS.memory);
  }
  if (inventory.artifacts.subjects.length) {
    requiredRootIds.add(ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact);
  }
  return [...requiredRootIds].sort(
    (left, right) => left.localeCompare(right)
  );
}

/**
 * Compiles one stable metadata-only inventory into a bounded logical
 * participant set. Leaf records remain explicit inside immutable bundles, so
 * a long-lived Conversation does not consume one Journal participant per
 * payload, Raw file, Memory record, or Artifact.
 */
export function buildConversationRecordMutationPlan(
  input: BuildConversationRecordMutationPlanInput
): BuiltConversationRecordMutationPlan {
  const inventory = requireReadyInventory(input.inventory);
  const conversationSources = normalizeConversationSources(
    input.conversationSources,
    inventory.operation,
    inventory.conversationId
  );
  const selectionDigest = recordMutationDigest({
    kind: "conversation-record-mutation-selection",
    operation: inventory.operation,
    conversationId: inventory.conversationId,
    inventorySnapshotDigest: inventory.snapshotDigest,
    conversationSources
  });
  const participants: RecordMutationExecutionParticipant[] = [];
  const conversationRootId = input.conversationRootId
    ?? ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation;
  const requiredRootIds = new Set<EchoInkRecordMutationRootId>(
    conversationRecordMutationRequiredRootIds(
      inventory,
      conversationRootId
    )
  );
  let leafRecordCount = 0;

  const conversationBundle = trashBundleParticipant({
    recordKind: "conversation",
    action: "stage",
    sourceRootId: conversationRootId,
    trashRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
    selectionDigest,
    items: conversationSources.map((sourceRelativePath) => ({
      itemId: leafRecordId("conversation-source", sourceRelativePath),
      sourceRelativePath
    }))
  });
  participants.push(conversationBundle);
  leafRecordCount += conversationBundle.execution.items.length;

  const runSubjects: Extract<
    RecordMutationExecutionSubject,
    { kind: "workflow-run" }
  >[] = [];
  const runTrashItems: Array<{
    itemId: string;
    sourceRelativePath: string;
  }> = [];
  const runRetainSubjects: RecordMutationExecutionRetainSubject[] = [];
  for (const workflow of inventory.run.workflowRuns) {
    runRetainSubjects.push({
      kind: "workflow-run-summary",
      workflowRunId: workflow.summary.workflowRunId,
      summaryDigest: workflow.summary.digest
    });
    for (const attempt of workflow.attempts) {
      if (!attempt.summary) {
        throw new ConversationRecordMutationPlanError(
          "inventory_blocked",
          `Attempt summary ${workflow.summary.workflowRunId}/${attempt.attemptId} 缺失`
        );
      }
      runRetainSubjects.push({
        kind: "attempt-run-summary",
        workflowRunId: workflow.summary.workflowRunId,
        attemptId: attempt.attemptId,
        summaryDigest: attempt.summary.digest
      });
      if (attempt.payload.state === "present") {
        const subject = {
          kind: "workflow-run" as const,
          workflowRunId: attempt.payload.manifest.workflowRunId,
          attemptId: attempt.payload.manifest.attemptId,
          harnessRunId: attempt.payload.manifest.harnessRunId,
          payloadDigest: attempt.payload.manifest.digest
        };
        runSubjects.push(subject);
        runTrashItems.push({
          itemId: workflowRunPayloadParticipantId(
            subject.workflowRunId,
            subject.attemptId
          ),
          sourceRelativePath: validateSourceRelativePath(
            attempt.payload.sourceRelativePath
          )
        });
        continue;
      }
      if (attempt.payload.state === "expired") {
        runRetainSubjects.push({
          kind: "attempt-payload-expired",
          workflowRunId: workflow.summary.workflowRunId,
          attemptId: attempt.attemptId,
          tombstoneDigest: attempt.payload.tombstone.digest
        });
        continue;
      }
      if (attempt.payload.state === "not-captured") {
        if (
          attempt.payload.reasonCode !== "failed-before-payload"
          && attempt.payload.reasonCode !== "capture-disabled"
          && attempt.payload.reasonCode !== "no-attempt-required"
        ) {
          throw new ConversationRecordMutationPlanError(
            "inventory_blocked",
            `Run payload ${workflow.summary.workflowRunId}/${attempt.attemptId} not-captured reason 非法`
          );
        }
        runRetainSubjects.push({
          kind: "attempt-payload-not-captured",
          workflowRunId: workflow.summary.workflowRunId,
          attemptId: attempt.attemptId,
          reasonCode: attempt.payload.reasonCode
        });
        continue;
      }
      throw new ConversationRecordMutationPlanError(
        "inventory_blocked",
        `Run payload ${workflow.summary.workflowRunId}/${attempt.attemptId} 缺失`
      );
    }
  }
  if (runRetainSubjects.length) {
    participants.push(retainBundleParticipant({
      recordKind: "workflow-run",
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      selectionDigest,
      subjects: runRetainSubjects
    }));
    leafRecordCount += runRetainSubjects.length;
  }
  if (runSubjects.length) {
    participants.push(sourceDeletionBundleParticipant({
      recordKind: "workflow-run",
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      selectionDigest,
      subjects: runSubjects
    }));
    participants.push(trashBundleParticipant({
      recordKind: "workflow-run",
      action: "discard",
      sourceRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      trashRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
      selectionDigest,
      items: runTrashItems
    }));
    leafRecordCount += runSubjects.length;
  }

  const rawRetainSubjects: RecordMutationExecutionRetainSubject[] = [];
  const rawTrashItems: Array<{
    itemId: string;
    sourceRelativePath: string;
  }> = [];
  for (const raw of inventory.raw.subjects) {
    const itemId = leafRecordId("raw", raw.rawRef);
    if (raw.action === "retain") {
      rawRetainSubjects.push({
        kind: "raw",
        rawRef: raw.rawRef,
        sourceRelativePath: validateSourceRelativePath(
          raw.sourceRelativePath
        ),
        ownersDigest: recordMutationDigest({
          kind: "conversation-raw-retain-owners",
          rawRef: raw.rawRef,
          owners: [...raw.owners].sort((left, right) => (
            stableRecordMutationStringify(left).localeCompare(
              stableRecordMutationStringify(right)
            )
          ))
        })
      });
    } else {
      rawTrashItems.push({
        itemId,
        sourceRelativePath: validateSourceRelativePath(
          raw.sourceRelativePath
        )
      });
    }
  }
  if (rawRetainSubjects.length) {
    participants.push(retainBundleParticipant({
      recordKind: "raw",
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.raw,
      selectionDigest,
      subjects: rawRetainSubjects
    }));
    leafRecordCount += rawRetainSubjects.length;
  }
  if (rawTrashItems.length) {
    participants.push(trashBundleParticipant({
      recordKind: "raw",
      action: "discard",
      sourceRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.raw,
      trashRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
      selectionDigest,
      items: rawTrashItems
    }));
    leafRecordCount += rawTrashItems.length;
  }

  const memorySubjects = inventory.memory.subjects.map((memory) => {
    if (memory.action !== "mark-source-deleted") {
      throw new ConversationRecordMutationPlanError(
        "inventory_blocked",
        `Memory ${memory.memoryId} 尚未完成 disposition`
      );
    }
    return {
      kind: "memory" as const,
      memoryId: memory.memoryId,
      state: memory.state
    };
  });
  if (memorySubjects.length) {
    participants.push(sourceDeletionBundleParticipant({
      recordKind: "memory",
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.memory,
      selectionDigest,
      subjects: memorySubjects
    }));
    leafRecordCount += memorySubjects.length;
  }

  const artifactSubjects = inventory.artifacts.subjects.map((artifact) => {
    if (artifact.action !== "mark-source-deleted") {
      throw new ConversationRecordMutationPlanError(
        "inventory_blocked",
        `Artifact ${artifact.artifactId} 尚未完成 disposition`
      );
    }
    return {
      kind: "artifact" as const,
      artifactId: artifact.artifactId,
      artifactKind: artifact.artifactKind
    };
  });
  if (artifactSubjects.length) {
    participants.push(sourceDeletionBundleParticipant({
      recordKind: "artifact",
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact,
      selectionDigest,
      subjects: artifactSubjects
    }));
    leafRecordCount += artifactSubjects.length;
  }

  const executionParticipants = participants.sort(
    (left, right) => left.participantId.localeCompare(right.participantId)
  );
  const normalizedRootIds = [...requiredRootIds].sort(
    (left, right) => left.localeCompare(right)
  );
  const rootBindings = normalizeRootBindings(
    input.rootBindings,
    normalizedRootIds
  );
  if (leafRecordCount > 100_000) {
    throw new ConversationRecordMutationPlanError(
      "capacity_exceeded",
      "Conversation 关联叶子记录超过本轮安全规划上限"
    );
  }
  const intent = parseRecordMutationIntent({
    operation: inventory.operation,
    conversationId: inventory.conversationId,
    expectedConversationGeneration: input.expectedConversationGeneration,
    expectedConversationCommitId: input.expectedConversationCommitId,
    expectedConversationContentRevision:
      input.expectedConversationContentRevision,
    targetConversation: input.targetConversation,
    participants: executionParticipants.map((participant) => ({
      id: participant.participantId,
      recordKind: participant.recordKind,
      action: participant.action
    })),
    rootBindings,
    trashPolicy: "required"
  });
  return {
    intent,
    executionParticipants,
    requiredRootIds: normalizedRootIds,
    selectionDigest,
    leafRecordCount
  };
}

function requireReadyInventory(
  inventory: ConversationRecordInventory
): ConversationRecordInventory & {
  run: NonNullable<ConversationRecordInventory["run"]>;
  memory: NonNullable<ConversationRecordInventory["memory"]>;
  artifacts: NonNullable<ConversationRecordInventory["artifacts"]>;
  raw: NonNullable<ConversationRecordInventory["raw"]>;
} {
  if (
    inventory.status !== "ready"
    || inventory.blockers.length !== 0
    || !inventory.run
    || !inventory.memory
    || !inventory.artifacts
    || !inventory.raw
  ) {
    throw new ConversationRecordMutationPlanError(
      "inventory_blocked",
      "Conversation record inventory 尚未达到可执行状态"
    );
  }
  return inventory as ConversationRecordInventory & {
    run: NonNullable<ConversationRecordInventory["run"]>;
    memory: NonNullable<ConversationRecordInventory["memory"]>;
    artifacts: NonNullable<ConversationRecordInventory["artifacts"]>;
    raw: NonNullable<ConversationRecordInventory["raw"]>;
  };
}

function normalizeConversationSources(
  input: readonly ConversationRecordMutationSource[],
  operation: ConversationRecordInventory["operation"],
  conversationId: string
): string[] {
  if (input.length < 1) {
    throw new ConversationRecordMutationPlanError(
      "source_invalid",
      "Conversation source plan 不能为空"
    );
  }
  const sources = input.map((source) => (
    validateSourceRelativePath(source.sourceRelativePath)
  )).sort((left, right) => left.localeCompare(right));
  if (new Set(sources).size !== sources.length) {
    throw new ConversationRecordMutationPlanError(
      "source_invalid",
      "Conversation source plan 含重复路径"
    );
  }
  if (!isSafeConversationSessionId(conversationId)) {
    throw new ConversationRecordMutationPlanError(
      "source_invalid",
      "Conversation source plan 的 Conversation ID 非法"
    );
  }
  const sessionPath = `sessions/${conversationId}`;
  if (operation === "delete-conversation") {
    if (sources.length !== 1 || sources[0] !== sessionPath) {
      throw new ConversationRecordMutationPlanError(
        "source_invalid",
        "删除会话的 source plan 必须精确绑定目标 Conversation 目录"
      );
    }
    return sources;
  }
  const prefix = `${sessionPath}/`;
  if (sources.some((source) => {
    if (!source.startsWith(prefix)) return true;
    const relative = source.slice(prefix.length);
    return relative !== "messages.jsonl"
      && relative !== "snapshots.jsonl"
      && !/^context-payloads\/payload-[a-f0-9]{64}$/.test(relative);
  })) {
    throw new ConversationRecordMutationPlanError(
      "source_invalid",
      "清空会话的 source plan 只能包含目标 Conversation 的 payload"
    );
  }
  return sources;
}

function validateSourceRelativePath(value: string): string {
  try {
    return validateDurableRelativePath(value);
  } catch {
    throw new ConversationRecordMutationPlanError(
      "source_invalid",
      "RecordMutation source relative path 非法"
    );
  }
}

function retainBundleParticipant(input: {
  recordKind: "workflow-run" | "raw";
  rootId: string;
  selectionDigest: string;
  subjects: readonly RecordMutationExecutionRetainSubject[];
}): RecordMutationExecutionParticipant {
  assertBundleCapacity(input.subjects.length);
  const execution = {
    kind: "retain-bundle" as const,
    rootId: input.rootId,
    selectionDigest: input.selectionDigest,
    subjects: input.subjects.map((subject) => ({ ...subject })).sort(
      (left, right) => stableRecordMutationStringify(left).localeCompare(
        stableRecordMutationStringify(right)
      )
    )
  };
  return {
    participantId: recordMutationExecutionBundleParticipantId({
      recordKind: input.recordKind,
      action: "retain",
      execution
    }),
    recordKind: input.recordKind,
    action: "retain",
    execution
  };
}

function trashBundleParticipant(input: {
  recordKind: "conversation" | "workflow-run" | "raw";
  action: "stage" | "discard";
  sourceRootId: string;
  trashRootId: string;
  selectionDigest: string;
  items: readonly {
    itemId: string;
    sourceRelativePath: string;
  }[];
}): RecordMutationExecutionParticipant & {
  execution: Extract<RecordMutationExecutionBundle, { kind: "trash-bundle" }>;
} {
  assertBundleCapacity(input.items.length);
  const execution = {
    kind: "trash-bundle" as const,
    sourceRootId: input.sourceRootId,
    trashRootId: input.trashRootId,
    selectionDigest: input.selectionDigest,
    items: input.items.map((item) => ({ ...item })).sort(
      (left, right) => (
        `${left.itemId}\0${left.sourceRelativePath}`.localeCompare(
          `${right.itemId}\0${right.sourceRelativePath}`
        )
      )
    )
  };
  return {
    participantId: recordMutationExecutionBundleParticipantId({
      recordKind: input.recordKind,
      action: input.action,
      execution
    }),
    recordKind: input.recordKind,
    action: input.action,
    execution
  };
}

function sourceDeletionBundleParticipant(input: {
  recordKind: "workflow-run" | "memory" | "artifact";
  rootId: string;
  selectionDigest: string;
  subjects: readonly RecordMutationExecutionSubject[];
}): RecordMutationExecutionParticipant {
  assertBundleCapacity(input.subjects.length);
  const execution = {
    kind: "source-deletion-bundle" as const,
    rootId: input.rootId,
    selectionDigest: input.selectionDigest,
    subjects: input.subjects.map((subject) => ({ ...subject })).sort(
      (left, right) => stableRecordMutationStringify(left).localeCompare(
        stableRecordMutationStringify(right)
      )
    )
  };
  return {
    participantId: recordMutationExecutionBundleParticipantId({
      recordKind: input.recordKind,
      action: "mark-source-deleted",
      execution
    }),
    recordKind: input.recordKind,
    action: "mark-source-deleted",
    execution
  };
}

function normalizeRootBindings(
  input: readonly RecordRootBindingRef[],
  requiredRootIds: readonly EchoInkRecordMutationRootId[]
): RecordRootBindingRef[] {
  const rootBindings = [...input].sort(
    (left, right) => left.rootId.localeCompare(right.rootId)
  );
  const actualRootIds = rootBindings.map((binding) => binding.rootId);
  if (
    rootBindings.length !== requiredRootIds.length
    || new Set(actualRootIds).size !== actualRootIds.length
    || actualRootIds.some(
      (rootId, index) => rootId !== requiredRootIds[index]
    )
  ) {
    throw new ConversationRecordMutationPlanError(
      "root_mismatch",
      "RecordMutation Root Binding 与 bundle execution plan 不完整同序"
    );
  }
  return rootBindings.map((binding) => ({
    ...binding,
    rootIdentity: { ...binding.rootIdentity }
  }));
}

function leafRecordId(kind: string, identity: unknown): string {
  const digest = recordMutationDigest({
    kind: "conversation-record-mutation-leaf",
    recordKind: kind,
    identity
  });
  return `leaf-${kind}-${digest.slice("sha256:".length, 31)}`;
}

function assertBundleCapacity(itemCount: number): void {
  if (
    !Number.isSafeInteger(itemCount)
    || itemCount < 1
    || itemCount > RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS
  ) {
    throw new ConversationRecordMutationPlanError(
      "capacity_exceeded",
      "Conversation record bundle 超过 execution plan 条目上限"
    );
  }
}
