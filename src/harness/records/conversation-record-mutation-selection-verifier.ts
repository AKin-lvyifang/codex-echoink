import {
  stableRecordMutationStringify,
  type RecordMutationIntent
} from "../lifecycle/record-mutation-contract";
import type {
  RecordMutationExecutionParticipant,
  RecordMutationExecutionSubject
} from "../lifecycle/record-mutation-execution-plan";
import type {
  RecordMutationFrozenSelectionVerifier
} from "../lifecycle/record-mutation-execution-runtime";
import type {
  StoredSession
} from "../../settings/settings";
import {
  inventoryConversationRecords,
  type ConversationRecordInventory
} from "./conversation-record-inventory";
import {
  buildConversationRecordMutationPlan,
  type BuiltConversationRecordMutationPlan
} from "./conversation-record-mutation-plan";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  type EchoInkRecordMutationRootId
} from "../lifecycle/record-mutation-production";

export interface EchoInkRecordMutationSelectionVerifierInput {
  vaultPath: string;
  pluginDir: string;
  getConversations(): readonly StoredSession[];
}

/**
 * Rebuilds the complete Conversation inventory twice immediately before the
 * first destructive preparation. Exact plan equality proves Run retain state,
 * Raw owner proof, source-deletion subjects, Trash leaves, decisions, roots,
 * and the common selection digest as one indivisible selection.
 */
export function createEchoInkRecordMutationSelectionVerifier(
  input: EchoInkRecordMutationSelectionVerifierInput
): RecordMutationFrozenSelectionVerifier {
  return async ({ plan, journal, roots }) => {
    const operation = journal.record.intent.operation;
    if (
      operation !== "clear-conversation-records"
      && operation !== "delete-conversation"
    ) {
      throw new Error(
        "Conversation RecordMutation selection verifier requires a destructive operation"
      );
    }
    const decisions = frozenDispositionDecisions(plan.participants);
    const conversationSources = frozenConversationSources(plan.participants);
    const conversationRootId = frozenConversationRootId(
      plan.participants
    );
    const inventoryInput = {
      operation,
      conversationId: journal.record.intent.conversationId,
      vaultPath: input.vaultPath,
      pluginDir: input.pluginDir,
      decisions
    } as const;
    const first = await inventoryConversationRecords({
      ...inventoryInput,
      conversations: cloneConversations(input.getConversations())
    });
    const second = await inventoryConversationRecords({
      ...inventoryInput,
      conversations: cloneConversations(input.getConversations())
    });
    assertReadyInventory(first);
    assertReadyInventory(second);
    if (first.snapshotDigest !== second.snapshotDigest) {
      throw new Error(
        "Conversation RecordMutation unified inventory changed during verification"
      );
    }
    const firstPlan = rebuildPlan(
      first,
      conversationSources,
      journal.record.intent,
      conversationRootId
    );
    const secondPlan = rebuildPlan(
      second,
      conversationSources,
      journal.record.intent,
      conversationRootId
    );
    assertRebuiltPlanMatchesFrozen(firstPlan, plan.participants);
    assertRebuiltPlanMatchesFrozen(secondPlan, plan.participants);
    if (
      firstPlan.selectionDigest !== secondPlan.selectionDigest
      || stableRecordMutationStringify(firstPlan.intent)
        !== stableRecordMutationStringify(secondPlan.intent)
      || stableRecordMutationStringify(firstPlan.executionParticipants)
        !== stableRecordMutationStringify(secondPlan.executionParticipants)
    ) {
      throw new Error(
        "Conversation RecordMutation rebuilt selection is unstable"
      );
    }
    const runtimeRootIds = roots.map((root) => root.rootId);
    if (
      stableRecordMutationStringify(runtimeRootIds)
      !== stableRecordMutationStringify(firstPlan.requiredRootIds)
    ) {
      throw new Error(
        "Conversation RecordMutation runtime roots changed after inventory"
      );
    }
  };
}

function rebuildPlan(
  inventory: ConversationRecordInventory,
  conversationSources: Array<{ sourceRelativePath: string }>,
  intent: RecordMutationIntent,
  conversationRootId: EchoInkRecordMutationRootId
): BuiltConversationRecordMutationPlan {
  if (intent.expectedConversationCommitId === null) {
    throw new Error(
      "Destructive RecordMutation selection requires a committed Conversation"
    );
  }
  return buildConversationRecordMutationPlan({
    inventory,
    conversationSources,
    expectedConversationGeneration: intent.expectedConversationGeneration,
    expectedConversationCommitId: intent.expectedConversationCommitId,
    expectedConversationContentRevision:
      intent.expectedConversationContentRevision,
    targetConversation: intent.targetConversation,
    rootBindings: intent.rootBindings,
    conversationRootId
  });
}

function frozenConversationRootId(
  participants: readonly RecordMutationExecutionParticipant[]
): EchoInkRecordMutationRootId {
  const candidates = participants.filter((participant) => (
    participant.recordKind === "conversation"
    && participant.action === "stage"
    && participant.execution.kind === "trash-bundle"
  ));
  if (
    candidates.length !== 1
    || candidates[0]?.execution.kind !== "trash-bundle"
  ) {
    throw new Error(
      "Conversation RecordMutation frozen source root is missing"
    );
  }
  const rootId = candidates[0].execution.sourceRootId;
  if (
    rootId !== ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
    && !/^echoink-conversation-store-[a-f0-9]{64}$/.test(rootId)
  ) {
    throw new Error(
      "Conversation RecordMutation frozen source root is invalid"
    );
  }
  return rootId as EchoInkRecordMutationRootId;
}

function assertRebuiltPlanMatchesFrozen(
  rebuilt: BuiltConversationRecordMutationPlan,
  frozenParticipants: readonly RecordMutationExecutionParticipant[]
): void {
  if (
    stableRecordMutationStringify(rebuilt.executionParticipants)
    !== stableRecordMutationStringify(frozenParticipants)
  ) {
    throw new Error(
      "Conversation RecordMutation execution participants changed after inventory"
    );
  }
  const frozenSelectionDigests = frozenParticipants.flatMap((participant) => (
    "selectionDigest" in participant.execution
      ? [participant.execution.selectionDigest]
      : []
  ));
  if (
    !frozenSelectionDigests.length
    || frozenSelectionDigests.some(
      (digest) => digest !== rebuilt.selectionDigest
    )
  ) {
    throw new Error(
      "Conversation RecordMutation selection digest changed after inventory"
    );
  }
}

function frozenConversationSources(
  participants: readonly RecordMutationExecutionParticipant[]
): Array<{ sourceRelativePath: string }> {
  const candidates = participants.filter((participant) => (
    participant.recordKind === "conversation"
    && participant.action === "stage"
  ));
  if (
    candidates.length !== 1
    || candidates[0]?.execution.kind !== "trash-bundle"
  ) {
    throw new Error(
      "Conversation RecordMutation frozen source bundle is missing"
    );
  }
  return candidates[0].execution.items.map((item) => ({
    sourceRelativePath: item.sourceRelativePath
  }));
}

function frozenDispositionDecisions(
  participants: readonly RecordMutationExecutionParticipant[]
): {
  retainMemoryIds: string[];
  retainArtifactIds: string[];
} {
  const retainMemoryIds: string[] = [];
  const retainArtifactIds: string[] = [];
  for (const participant of participants) {
    if (participant.action !== "mark-source-deleted") continue;
    const subjects: readonly RecordMutationExecutionSubject[] =
      participant.execution.kind === "source-deletion-bundle"
        ? participant.execution.subjects
        : participant.execution.kind === "source-deletion"
          ? [participant.execution.subject]
          : [];
    for (const subject of subjects) {
      if (subject.kind === "memory" && subject.state === "confirmation") {
        retainMemoryIds.push(subject.memoryId);
      } else if (subject.kind === "artifact") {
        retainArtifactIds.push(subject.artifactId);
      }
    }
  }
  return {
    retainMemoryIds: normalizeIds(retainMemoryIds),
    retainArtifactIds: normalizeIds(retainArtifactIds)
  };
}

function cloneConversations(
  input: readonly StoredSession[]
): StoredSession[] {
  if (!Array.isArray(input)) {
    throw new Error(
      "Conversation RecordMutation current Conversation set is invalid"
    );
  }
  return structuredClone(input) as StoredSession[];
}

function assertReadyInventory(
  inventory: ConversationRecordInventory
): void {
  if (
    inventory.status !== "ready"
    || inventory.blockers.length !== 0
  ) {
    throw new Error(
      `Conversation RecordMutation inventory is blocked: ${
        inventory.blockers.map((blocker) => (
          `${blocker.code}:${blocker.subjectId}`
        )).join(",")
      }`
    );
  }
}

function normalizeIds(input: readonly string[]): string[] {
  const sorted = [...input].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(
      "Conversation RecordMutation disposition decision is duplicated"
    );
  }
  return sorted;
}
