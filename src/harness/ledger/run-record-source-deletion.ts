import * as path from "node:path";
import {
  finalizeRetentionTombstone,
  type AttemptPayloadManifestV1,
  type RunRetentionTombstoneV1
} from "../contracts/run-record";
import {
  recordMutationDigest
} from "../lifecycle/record-mutation-contract";
import {
  createRecordMutationSourceParticipantReceipt,
  type RecordMutationSourceParticipantAdapter,
  type RecordMutationSourceParticipantObservation,
  type RecordMutationSourceParticipantReceipt
} from "../lifecycle/record-mutation-source-participant";
import {
  parseRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  FileRunRecordStore,
  RUN_RECORD_STORE_DIRECTORY,
  type AttemptPayloadUserDeletionObservation,
  type RunRecordStoreFaultInjector
} from "./run-record-store";

const runPayloadMutationTails = new Map<string, Promise<void>>();

export interface RunRecordSourceDeletionAdapterInput {
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  mutationId: string;
  conversationId: string;
  participantId: string;
  workflowRunId: string;
  attemptId: string;
  harnessRunId: string;
  payloadDigest: string;
  faultInjector?: (
    phase: "source-deleted" | "source-restored"
  ) => RunRecordStoreFaultInjector | undefined;
}

export function createRunRecordSourceDeletionAdapter(
  input: RunRecordSourceDeletionAdapterInput
): RecordMutationSourceParticipantAdapter {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const rootPath = requireAbsolutePath(input.rootPath, "rootPath");
  if (
    rootPath
    !== path.join(storageRootPath, RUN_RECORD_STORE_DIRECTORY)
  ) {
    throw new Error(
      "Workflow Run source deletion root does not match the formal Run Store"
    );
  }
  const boundaryRootPath = requireAbsolutePath(
    input.boundaryRootPath,
    "boundaryRootPath"
  );
  const rootBinding = parseRecordRootBindingRef(input.rootBinding);
  const identity = {
    mutationId: requireSafeId(input.mutationId, "mutationId"),
    conversationId: requireSafeId(
      input.conversationId,
      "conversationId"
    ),
    participantId: requireSafeId(
      input.participantId,
      "participantId"
    )
  };
  const subject = {
    workflowRunId: requireSafeId(
      input.workflowRunId,
      "workflowRunId"
    ),
    attemptId: requireSafeId(input.attemptId, "attemptId"),
    harnessRunId: requireSafeId(input.harnessRunId, "harnessRunId"),
    payloadDigest: requireDigest(input.payloadDigest, "payloadDigest")
  };
  const forwardEffectId = runPayloadEffectId(
    "source-deleted",
    identity,
    subject
  );
  const restoreEffectId = runPayloadEffectId(
    "source-restored",
    identity,
    subject
  );
  const store = new FileRunRecordStore({ storageRootPath });
  let authorityHeld = false;
  const requireAuthority = (): void => {
    if (!authorityHeld) {
      throw new Error(
        "Workflow Run source deletion requires mutation authority"
      );
    }
  };
  const assertIdentity = (candidate: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): void => {
    if (
      candidate.mutationId !== identity.mutationId
      || candidate.conversationId !== identity.conversationId
      || candidate.participantId !== identity.participantId
    ) {
      throw new Error(
        "Workflow Run source deletion participant identity mismatch"
      );
    }
  };
  const inspect = async (candidate: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): Promise<RecordMutationSourceParticipantObservation> => {
    assertIdentity(candidate);
    const observation = await store.inspectAttemptPayloadUserDeletion({
      workflowRunId: subject.workflowRunId,
      attemptId: subject.attemptId,
      forwardEffectId
    });
    assertFrozenRunPayload(observation, subject);
    return sourceParticipantObservation(
      identity,
      subject,
      restoreEffectId,
      observation
    );
  };
  return {
    participantId: identity.participantId,
    recordKind: "workflow-run",
    storageRootPath,
    rootPath,
    boundaryRootPath,
    rootBinding,
    withMutation: async <T>(action: () => Promise<T>): Promise<T> => (
      await enqueueRunPayloadMutation(
        `${rootPath}\0${identity.participantId}`,
        async () => {
          if (authorityHeld) {
            throw new Error(
              "Workflow Run source deletion authority cannot nest"
            );
          }
          authorityHeld = true;
          try {
            return await action();
          } finally {
            authorityHeld = false;
          }
        }
      )
    ),
    recover: async () => {
      requireAuthority();
      await store.recoverAttemptPayloadUserDeletion({
        workflowRunId: subject.workflowRunId,
        attemptId: subject.attemptId,
        forwardEffectId
      });
    },
    inspect: async (candidate) => {
      requireAuthority();
      return await inspect(candidate);
    },
    stage: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      const current = await inspect(effect);
      if (current.status === "source-deleted") {
        return current.forwardReceipt;
      }
      if (current.status === "source-restored") {
        throw new Error(
          "Workflow Run payload source deletion is already restored"
        );
      }
      const storeObservation =
        await store.inspectAttemptPayloadUserDeletion({
          workflowRunId: subject.workflowRunId,
          attemptId: subject.attemptId,
          forwardEffectId
        });
      if (storeObservation.status !== "before") {
        throw new Error(
          "Workflow Run payload source deletion precondition changed"
        );
      }
      const tombstone = userDeletionTombstone(
        storeObservation.manifest,
        forwardEffectId,
        effect.occurredAt
      );
      await store.publishAttemptPayloadTombstone(
        tombstone,
        {
          expectedRevision: storeObservation.manifest.revision,
          expectedDigest: storeObservation.manifest.digest
        },
        input.faultInjector?.("source-deleted")
      );
      const readback = await inspect(effect);
      if (readback.status !== "source-deleted") {
        throw new Error(
          "Workflow Run payload source deletion readback failed"
        );
      }
      return readback.forwardReceipt;
    },
    restore: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      const current = await inspect(effect);
      if (current.status === "before") {
        throw new Error(
          "Workflow Run payload source deletion marker is missing"
        );
      }
      if (current.forwardReceipt.digest !== effect.forwardReceipt.digest) {
        throw new Error(
          "Workflow Run payload source deletion receipt changed"
        );
      }
      if (current.status === "source-restored") {
        return current.restoreReceipt;
      }
      await store.restoreAttemptPayloadUserDeletion({
        workflowRunId: subject.workflowRunId,
        attemptId: subject.attemptId,
        forwardEffectId,
        occurredAt: effect.occurredAt,
        faultInjector: input.faultInjector?.("source-restored")
      });
      const readback = await inspect(effect);
      if (readback.status !== "source-restored") {
        throw new Error(
          "Workflow Run payload source restoration readback failed"
        );
      }
      return readback.restoreReceipt;
    }
  };
}

function sourceParticipantObservation(
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  subject: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
    payloadDigest: string;
  },
  restoreEffectId: string,
  observation: AttemptPayloadUserDeletionObservation
): RecordMutationSourceParticipantObservation {
  if (observation.status === "before") return { status: "before" };
  const forwardReceipt = runPayloadForwardReceipt(
    identity,
    subject,
    observation.tombstone
  );
  if (observation.status === "source-deleted") {
    return {
      status: "source-deleted",
      forwardReceipt
    };
  }
  return {
    status: "source-restored",
    forwardReceipt,
    restoreReceipt: createRecordMutationSourceParticipantReceipt({
      ...identity,
      recordKind: "workflow-run",
      phase: "source-restored",
      effectId: restoreEffectId,
      effectDigest: recordMutationDigest({
        kind: "workflow-run-payload-source-restoration",
        ...subject,
        tombstoneDigest: observation.tombstone.digest,
        restoredManifestDigest: observation.restoredManifest.digest,
        restoredAt: observation.restoredAt,
        effectId: restoreEffectId
      }),
      occurredAt: observation.restoredAt
    })
  };
}

function runPayloadForwardReceipt(
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  subject: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
    payloadDigest: string;
  },
  tombstone: RunRetentionTombstoneV1
): RecordMutationSourceParticipantReceipt {
  return createRecordMutationSourceParticipantReceipt({
    ...identity,
    recordKind: "workflow-run",
    phase: "source-deleted",
    effectId: tombstone.retentionTransactionId,
    effectDigest: recordMutationDigest({
      kind: "workflow-run-payload-source-deletion",
      ...subject,
      tombstoneDigest: tombstone.digest,
      effectId: tombstone.retentionTransactionId
    }),
    occurredAt: tombstone.committedAt
  });
}

function userDeletionTombstone(
  manifest: AttemptPayloadManifestV1,
  forwardEffectId: string,
  occurredAt: number
): RunRetentionTombstoneV1 {
  return finalizeRetentionTombstone({
    schemaVersion: 1,
    recordType: "run-retention-tombstone",
    scope: "attempt-payload",
    workflowRunId: manifest.workflowRunId,
    attemptId: manifest.attemptId,
    harnessRunId: manifest.harnessRunId,
    subjectDigest: manifest.subjectDigest,
    reasonCode: "user-deleted",
    eligibleAt: occurredAt,
    expiredAt: occurredAt,
    prior: {
      schemaVersion: manifest.schemaVersion,
      digest: manifest.digest,
      eventCount: manifest.eventCount,
      byteCount: manifest.byteCount,
      terminalAt: manifest.terminalAt
    },
    policy: {
      version: 1,
      retentionDays: 0
    },
    retentionTransactionId: forwardEffectId,
    committedAt: occurredAt,
    revision: manifest.revision + 1
  });
}

function assertFrozenRunPayload(
  observation: AttemptPayloadUserDeletionObservation,
  subject: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
    payloadDigest: string;
  }
): void {
  const workflowRunId = observation.status === "before"
    ? observation.manifest.workflowRunId
    : observation.tombstone.workflowRunId;
  const attemptId = observation.status === "before"
    ? observation.manifest.attemptId
    : observation.tombstone.attemptId;
  const harnessRunId = observation.status === "before"
    ? observation.manifest.harnessRunId
    : observation.tombstone.harnessRunId;
  const payloadDigest = observation.status === "before"
    ? observation.manifest.digest
    : observation.tombstone.prior.digest;
  if (
    workflowRunId !== subject.workflowRunId
    || attemptId !== subject.attemptId
    || harnessRunId !== subject.harnessRunId
    || payloadDigest !== subject.payloadDigest
  ) {
    throw new Error(
      "Workflow Run source deletion frozen payload identity changed"
    );
  }
}

function runPayloadEffectId(
  phase: "source-deleted" | "source-restored",
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  subject: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
    payloadDigest: string;
  }
): string {
  const digest = recordMutationDigest({
    kind: "workflow-run-payload-effect-id",
    phase,
    ...identity,
    ...subject
  });
  return `run-${phase}-${digest.slice("sha256:".length, 31)}`;
}

async function enqueueRunPayloadMutation<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = runPayloadMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runPayloadMutationTails.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runPayloadMutationTails.get(key) === tail) {
      runPayloadMutationTails.delete(key);
    }
  }
}

function requireSafeId(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,319}$/.test(value)
  ) {
    throw new Error(`Workflow Run source deletion ${label} is invalid`);
  }
  return value;
}

function requireDigest(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Workflow Run source deletion ${label} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !path.isAbsolute(value)
    || value.includes("\0")
  ) {
    throw new Error(`Workflow Run source deletion ${label} is invalid`);
  }
  return path.resolve(value);
}
