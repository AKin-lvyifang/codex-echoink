import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  commitFormalMemoryIndexSnapshot,
  recoverMemoryTransactionsUnderAuthority,
  type MemoryConfirmationV2,
  type MemoryRecordV2,
  type MemorySourceDeletionV2
} from "./v2-engine";
import {
  echoInkMemoryV2Layout,
  readMemoryIndexV2,
  readMemoryManifestV2,
  withMemoryFormalMutation,
  type MemoryIndexV2
} from "./v2-store";
import {
  createRecordMutationSourceParticipantReceipt,
  type RecordMutationSourceParticipantAdapter,
  type RecordMutationSourceParticipantObservation,
  type RecordMutationSourceParticipantReceipt
} from "../lifecycle/record-mutation-source-participant";
import { recordMutationDigest } from "../lifecycle/record-mutation-contract";
import {
  parseRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";

interface MutableMemorySubject {
  record: MemoryRecordV2 | Omit<MemoryRecordV2, "createdAt" | "updatedAt">;
  touch(at: number): void;
}

export interface MemorySourceDeletionAdapterInput {
  vaultPath: string;
  storageRootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  participantId: string;
  subjectState?: "formal" | "confirmation";
  failAfterIndexWrite?: (
    phase: "source-deleted" | "source-restored"
  ) => boolean;
}

export function createMemorySourceDeletionAdapter(
  input: MemorySourceDeletionAdapterInput
): RecordMutationSourceParticipantAdapter {
  const rootBinding = parseRecordRootBindingRef(input.rootBinding);
  const rootPath = echoInkMemoryV2Layout(input.vaultPath).root;
  let authorityHeld = false;
  const requireAuthority = (): void => {
    if (!authorityHeld) {
      throw new Error("Memory source deletion requires formal authority");
    }
  };
  const adapter: RecordMutationSourceParticipantAdapter = {
    participantId: input.participantId,
    recordKind: "memory",
    storageRootPath: input.storageRootPath,
    rootPath,
    boundaryRootPath: input.boundaryRootPath,
    rootBinding,
    withMutation: async <T>(action: () => Promise<T>): Promise<T> => (
      await withMemoryFormalMutation(input.vaultPath, async () => {
        if (authorityHeld) {
          throw new Error("Memory source deletion authority cannot nest");
        }
        authorityHeld = true;
        try {
          return await action();
        } finally {
          authorityHeld = false;
        }
      })
    ),
    recover: async () => {
      requireAuthority();
      await requireExistingFormalMemoryStore(input.vaultPath);
      await recoverMemoryTransactionsUnderAuthority(
        input.vaultPath,
        { lockHeld: true }
      );
    },
    inspect: async (identity) => {
      requireAuthority();
      return await inspectMemorySourceDeletion({
        vaultPath: input.vaultPath,
        participantId: identity.participantId,
        mutationId: identity.mutationId,
        conversationId: identity.conversationId,
        subjectState: input.subjectState
      });
    },
    stage: async (effect) => {
      requireAuthority();
      return await stageMemorySourceDeletion({
        vaultPath: input.vaultPath,
        participantId: effect.participantId,
        mutationId: effect.mutationId,
        conversationId: effect.conversationId,
        subjectState: input.subjectState,
        occurredAt: effect.occurredAt,
        failAfterIndexWrite:
          input.failAfterIndexWrite?.("source-deleted") === true
      });
    },
    restore: async (effect) => {
      requireAuthority();
      return await restoreMemorySourceDeletion({
        vaultPath: input.vaultPath,
        participantId: effect.participantId,
        mutationId: effect.mutationId,
        conversationId: effect.conversationId,
        subjectState: input.subjectState,
        forwardReceipt: effect.forwardReceipt,
        occurredAt: effect.occurredAt,
        failAfterIndexWrite:
          input.failAfterIndexWrite?.("source-restored") === true
      });
    }
  };
  return adapter;
}

async function requireExistingFormalMemoryStore(
  vaultPath: string
): Promise<void> {
  const layout = echoInkMemoryV2Layout(vaultPath);
  const requiredFiles = [layout.manifest, layout.index];
  for (const absolutePath of requiredFiles) {
    const file = await lstat(absolutePath);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
      throw new Error(
        `Memory source deletion formal file is unsafe: ${pathLabel(absolutePath)}`
      );
    }
  }
  const transactions = await lstat(layout.transactions);
  if (
    !transactions.isDirectory()
    || transactions.isSymbolicLink()
    || transactions.nlink < 1
  ) {
    throw new Error("Memory source deletion transaction root is unsafe");
  }
}

function pathLabel(absolutePath: string): string {
  const parts = absolutePath.split(/[\\/]/);
  return parts[parts.length - 1] || "unknown";
}

async function inspectMemorySourceDeletion(input: {
  vaultPath: string;
  participantId: string;
  mutationId: string;
  conversationId: string;
  subjectState?: "formal" | "confirmation";
}): Promise<RecordMutationSourceParticipantObservation> {
  const manifest = await readMemoryManifestV2(input.vaultPath);
  const index = await readMemoryIndexV2<MemoryRecordV2>(input.vaultPath);
  if (manifest.revision !== index.revision) {
    throw new Error(
      `Memory source deletion revision mismatch: ${manifest.revision}/${index.revision}`
    );
  }
  const subject = locateMemorySubject(
    index,
    input.participantId,
    input.subjectState
  );
  assertMemoryLineage(subject.record, input.conversationId);
  const markers = subject.record.sourceDeletions ?? [];
  const matches = markers.filter(
    (marker) => marker.mutationId === input.mutationId
  );
  if (matches.length > 1) {
    throw new Error(
      `Memory ${input.participantId} contains duplicate source deletion markers`
    );
  }
  const marker = matches[0];
  if (!marker) return { status: "before" };
  if (marker.conversationId !== input.conversationId) {
    throw new Error(
      `Memory ${input.participantId} source deletion conversation conflicts`
    );
  }
  const forwardReceipt = memorySourceDeletionReceipt(
    input.participantId,
    marker,
    "source-deleted"
  );
  if (marker.restoredAt === undefined) {
    return { status: "source-deleted", forwardReceipt };
  }
  return {
    status: "source-restored",
    forwardReceipt,
    restoreReceipt: memorySourceDeletionReceipt(
      input.participantId,
      marker,
      "source-restored"
    )
  };
}

async function stageMemorySourceDeletion(input: {
  vaultPath: string;
  participantId: string;
  mutationId: string;
  conversationId: string;
  subjectState?: "formal" | "confirmation";
  occurredAt: number;
  failAfterIndexWrite: boolean;
}): Promise<RecordMutationSourceParticipantReceipt> {
  const existing = await inspectMemorySourceDeletion(input);
  if (existing.status === "source-deleted") return existing.forwardReceipt;
  if (existing.status === "source-restored") {
    throw new Error(
      `Memory ${input.participantId} source deletion is already restored`
    );
  }
  const index = cloneMemoryIndex(
    await readMemoryIndexV2<MemoryRecordV2>(input.vaultPath)
  );
  const subject = locateMemorySubject(
    index,
    input.participantId,
    input.subjectState
  );
  assertMemoryLineage(subject.record, input.conversationId);
  const transactionId = `memory-source-delete-${randomUUID()}`;
  const marker: MemorySourceDeletionV2 = {
    mutationId: input.mutationId,
    conversationId: input.conversationId,
    deletedAt: input.occurredAt,
    forwardTransactionId: transactionId
  };
  subject.record.sourceDeletions = [
    ...(subject.record.sourceDeletions ?? []).map((item) => ({ ...item })),
    marker
  ].sort((left, right) => left.mutationId.localeCompare(right.mutationId));
  subject.touch(input.occurredAt);
  await commitFormalMemoryIndexSnapshot(
    input.vaultPath,
    index,
    input.occurredAt,
    {
      operation: "record-mutation-source-deleted",
      lockHeld: true,
      transactionId,
      failAfterIndexWrite: input.failAfterIndexWrite
    }
  );
  const readback = await inspectMemorySourceDeletion(input);
  if (readback.status !== "source-deleted") {
    throw new Error(
      `Memory ${input.participantId} source deletion readback failed`
    );
  }
  return readback.forwardReceipt;
}

async function restoreMemorySourceDeletion(input: {
  vaultPath: string;
  participantId: string;
  mutationId: string;
  conversationId: string;
  subjectState?: "formal" | "confirmation";
  forwardReceipt: RecordMutationSourceParticipantReceipt;
  occurredAt: number;
  failAfterIndexWrite: boolean;
}): Promise<RecordMutationSourceParticipantReceipt> {
  const existing = await inspectMemorySourceDeletion(input);
  if (existing.status === "before") {
    throw new Error(
      `Memory ${input.participantId} source deletion marker is missing`
    );
  }
  if (existing.forwardReceipt.digest !== input.forwardReceipt.digest) {
    throw new Error(
      `Memory ${input.participantId} source deletion receipt changed`
    );
  }
  if (existing.status === "source-restored") return existing.restoreReceipt;
  const index = cloneMemoryIndex(
    await readMemoryIndexV2<MemoryRecordV2>(input.vaultPath)
  );
  const subject = locateMemorySubject(
    index,
    input.participantId,
    input.subjectState
  );
  const marker = requireMemoryMarker(
    subject.record,
    input.mutationId,
    input.conversationId
  );
  const transactionId = `memory-source-restore-${randomUUID()}`;
  marker.restoredAt = input.occurredAt;
  marker.restoreTransactionId = transactionId;
  subject.touch(input.occurredAt);
  await commitFormalMemoryIndexSnapshot(
    input.vaultPath,
    index,
    input.occurredAt,
    {
      operation: "record-mutation-source-restored",
      lockHeld: true,
      transactionId,
      failAfterIndexWrite: input.failAfterIndexWrite
    }
  );
  const readback = await inspectMemorySourceDeletion(input);
  if (readback.status !== "source-restored") {
    throw new Error(
      `Memory ${input.participantId} source restore readback failed`
    );
  }
  return readback.restoreReceipt;
}

function locateMemorySubject(
  index: MemoryIndexV2<MemoryRecordV2>,
  participantId: string,
  expectedState?: "formal" | "confirmation"
): MutableMemorySubject {
  const memoryMatches = index.memories
    .map((record, indexPosition) => ({ record, indexPosition }))
    .filter(({ record }) => record.id === participantId);
  const confirmations = index.confirmations as MemoryConfirmationV2[];
  const confirmationMatches = confirmations
    .map((confirmation, indexPosition) => ({ confirmation, indexPosition }))
    .filter(({ confirmation }) => confirmation.id === participantId);
  if (memoryMatches.length + confirmationMatches.length !== 1) {
    throw new Error(
      `Memory source participant ${participantId} is missing or ambiguous`
    );
  }
  const memory = memoryMatches[0];
  if (memory) {
    if (expectedState === "confirmation") {
      throw new Error(
        `Memory source participant ${participantId} expected confirmation state`
      );
    }
    return {
      record: memory.record,
      touch: (at) => {
        index.memories[memory.indexPosition].updatedAt = at;
      }
    };
  }
  const confirmation = confirmationMatches[0];
  if (!confirmation) {
    throw new Error(`Memory source participant ${participantId} is missing`);
  }
  if (expectedState === "formal") {
    throw new Error(
      `Memory source participant ${participantId} expected formal state`
    );
  }
  return {
    record: confirmation.confirmation.candidate,
    touch: () => undefined
  };
}

function assertMemoryLineage(
  record: MemoryRecordV2 | Omit<MemoryRecordV2, "createdAt" | "updatedAt">,
  conversationId: string
): void {
  if (
    !record.sourceConversationIds
    || !record.sourceConversationIds.includes(conversationId)
  ) {
    throw new Error(
      `Memory ${record.id} has incomplete Conversation lineage`
    );
  }
}

function requireMemoryMarker(
  record: MemoryRecordV2 | Omit<MemoryRecordV2, "createdAt" | "updatedAt">,
  mutationId: string,
  conversationId: string
): MemorySourceDeletionV2 {
  const matches = (record.sourceDeletions ?? []).filter(
    (marker) => marker.mutationId === mutationId
  );
  if (
    matches.length !== 1
    || matches[0].conversationId !== conversationId
    || matches[0].restoredAt !== undefined
  ) {
    throw new Error(`Memory ${record.id} source deletion marker conflicts`);
  }
  return matches[0];
}

function memorySourceDeletionReceipt(
  participantId: string,
  marker: MemorySourceDeletionV2,
  phase: "source-deleted" | "source-restored"
): RecordMutationSourceParticipantReceipt {
  if (
    phase === "source-restored"
    && (
      marker.restoredAt === undefined
      || marker.restoreTransactionId === undefined
    )
  ) {
    throw new Error("Memory source restore marker is incomplete");
  }
  const effect = phase === "source-deleted"
    ? {
        kind: "memory-source-deletion",
        participantId,
        mutationId: marker.mutationId,
        conversationId: marker.conversationId,
        deletedAt: marker.deletedAt,
        transactionId: marker.forwardTransactionId
      }
    : {
        kind: "memory-source-restoration",
        participantId,
        mutationId: marker.mutationId,
        conversationId: marker.conversationId,
        deletedAt: marker.deletedAt,
        forwardTransactionId: marker.forwardTransactionId,
        restoredAt: marker.restoredAt,
        transactionId: marker.restoreTransactionId
      };
  return createRecordMutationSourceParticipantReceipt({
    mutationId: marker.mutationId,
    conversationId: marker.conversationId,
    participantId,
    recordKind: "memory",
    phase,
    effectId: phase === "source-deleted"
      ? marker.forwardTransactionId
      : marker.restoreTransactionId!,
    effectDigest: recordMutationDigest(effect),
    occurredAt: phase === "source-deleted"
      ? marker.deletedAt
      : marker.restoredAt!
  });
}

function cloneMemoryIndex(
  index: MemoryIndexV2<MemoryRecordV2>
): MemoryIndexV2<MemoryRecordV2> {
  return JSON.parse(JSON.stringify(index)) as MemoryIndexV2<MemoryRecordV2>;
}
