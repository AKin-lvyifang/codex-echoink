import * as path from "node:path";
import {
  recordMutationDigest,
  stableRecordMutationStringify
} from "./record-mutation-contract";
import {
  recordMutationExecutionBundleParticipantId,
  workflowRunPayloadParticipantId,
  type RecordMutationExecutionSubject
} from "./record-mutation-execution-plan";
import {
  createRecordMutationSourceParticipantReceipt,
  parseRecordMutationSourceParticipantReceipt,
  type RecordMutationSourceParticipantAdapter,
  type RecordMutationSourceParticipantKind,
  type RecordMutationSourceParticipantObservation,
  type RecordMutationSourceParticipantReceipt
} from "./record-mutation-source-participant";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  verifyRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const sourceBundleMutationTails = new Map<string, Promise<void>>();

export interface RecordMutationSourceBundleAdapterInput {
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  selectionDigest: string;
  subjects: readonly RecordMutationExecutionSubject[];
  leafAdapters: readonly RecordMutationSourceParticipantAdapter[];
}

interface SourceBundleLeaf {
  subject: RecordMutationExecutionSubject;
  subjectKey: string;
  adapter: RecordMutationSourceParticipantAdapter;
}

interface ObservedSourceBundleLeaf extends SourceBundleLeaf {
  observation: RecordMutationSourceParticipantObservation;
}

/**
 * Coordinates a logical source-deletion participant while preserving the
 * durable receipt of every Store-owned leaf. No aggregate Store is introduced:
 * the aggregate receipt is rebuilt deterministically from the immutable plan
 * subjects and the complete ordered set of leaf receipts after every restart.
 */
export function createRecordMutationSourceBundleAdapter(
  input: RecordMutationSourceBundleAdapterInput
): RecordMutationSourceParticipantAdapter {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const rootPath = requireAbsolutePath(input.rootPath, "rootPath");
  const boundaryRootPath = requireAbsolutePath(
    input.boundaryRootPath,
    "boundaryRootPath"
  );
  const rootBinding = parseRecordRootBindingRef(input.rootBinding);
  const recordKind = requireBundleRecordKind(input.recordKind);
  const selectionDigest = requireDigest(
    input.selectionDigest,
    "selectionDigest"
  );
  const subjects = normalizeSubjects(input.subjects, recordKind);
  const participantId = requireBundleParticipantId(
    input.participantId,
    recordKind,
    rootBinding.rootId,
    selectionDigest,
    subjects
  );
  const leaves = normalizeLeaves({
    storageRootPath,
    rootPath,
    boundaryRootPath,
    rootBinding,
    recordKind,
    subjects,
    leafAdapters: input.leafAdapters
  });
  const laneKey = `${storageRootPath}\0${rootPath}\0${participantId}`;
  let authorityHeld = false;
  const requireAuthority = (): void => {
    if (!authorityHeld) {
      throw new Error(
        `source bundle ${participantId} requires mutation authority`
      );
    }
  };
  const assertIdentity = (identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): void => {
    if (identity.participantId !== participantId) {
      throw new Error(
        `source bundle ${participantId} participant identity mismatch`
      );
    }
  };
  const verifyRoot = async (): Promise<void> => {
    await verifyRecordRootBindingRef(rootBinding, {
      storageRootPath,
      rootPath,
      boundaryRootPath
    });
  };
  const withLeafMutation = async <T>(
    leaf: SourceBundleLeaf,
    action: () => Promise<T>
  ): Promise<T> => {
    assertLeafAdapterMatches({
      leaf,
      storageRootPath,
      rootPath,
      boundaryRootPath,
      rootBinding,
      recordKind
    });
    await verifyRoot();
    return await leaf.adapter.withMutation(async () => {
      await verifyRoot();
      const result = await action();
      await verifyRoot();
      return result;
    });
  };
  const inspectLeaves = async (identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): Promise<ObservedSourceBundleLeaf[]> => {
    assertIdentity(identity);
    const observations: ObservedSourceBundleLeaf[] = [];
    for (const leaf of leaves) {
      const leafIdentity = {
        mutationId: identity.mutationId,
        conversationId: identity.conversationId,
        participantId: leaf.adapter.participantId
      };
      const observation = await withLeafMutation(
        leaf,
        async () => parseLeafObservation(
          await leaf.adapter.inspect(leafIdentity),
          leafIdentity,
          recordKind
        )
      );
      observations.push({ ...leaf, observation });
    }
    return observations;
  };
  const inspect = async (identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): Promise<RecordMutationSourceParticipantObservation> => (
    aggregateObservation({
      identity,
      participantId,
      recordKind,
      selectionDigest,
      rootBinding,
      leaves: await inspectLeaves(identity)
    })
  );
  const completeMissingForwardLeaves = async (
    identity: {
      mutationId: string;
      conversationId: string;
      participantId: string;
    },
    occurredAt: number,
    onlyIfPartial: boolean
  ): Promise<void> => {
    const observed = await inspectLeaves(identity);
    const beforeCount = observed.filter(
      (leaf) => leaf.observation.status === "before"
    ).length;
    if (beforeCount === observed.length && onlyIfPartial) return;
    if (
      beforeCount > 0
      && observed.some(
        (leaf) => leaf.observation.status === "source-restored"
      )
    ) {
      throw new Error(
        `source bundle ${participantId} has incompatible partial restore`
      );
    }
    for (const [index, leaf] of observed.entries()) {
      if (leaf.observation.status !== "before") continue;
      const leafIdentity = {
        mutationId: identity.mutationId,
        conversationId: identity.conversationId,
        participantId: leaf.adapter.participantId
      };
      await withLeafMutation(leaf, async () => {
        const current = parseLeafObservation(
          await leaf.adapter.inspect(leafIdentity),
          leafIdentity,
          recordKind
        );
        if (current.status === "source-restored") {
          throw new Error(
            `source bundle leaf ${leaf.adapter.participantId} is restored`
          );
        }
        if (current.status === "source-deleted") return;
        await leaf.adapter.stage({
          ...leafIdentity,
          occurredAt: leafTimestamp(occurredAt, index)
        });
        const readback = parseLeafObservation(
          await leaf.adapter.inspect(leafIdentity),
          leafIdentity,
          recordKind
        );
        if (readback.status !== "source-deleted") {
          throw new Error(
            `source bundle leaf ${leaf.adapter.participantId} forward readback mismatch`
          );
        }
      });
    }
  };
  return {
    participantId,
    recordKind,
    storageRootPath,
    rootPath,
    boundaryRootPath,
    rootBinding,
    withMutation: async <T>(action: () => Promise<T>): Promise<T> => (
      await enqueueSourceBundleMutation(laneKey, async () => {
        if (authorityHeld) {
          throw new Error(
            `source bundle ${participantId} authority cannot nest`
          );
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
      for (const leaf of leaves) {
        await withLeafMutation(leaf, async () => {
          await leaf.adapter.recover();
        });
      }
    },
    inspect: async (identity) => {
      requireAuthority();
      return await inspect(identity);
    },
    reconcileForward: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      await completeMissingForwardLeaves(
        effect,
        effect.occurredAt,
        true
      );
    },
    verifyForwardState: async (identity) => {
      requireAuthority();
      assertIdentity(identity);
      const observed = await inspectLeaves(identity);
      if (!observed.every(
        (leaf) => leaf.observation.status === "source-deleted"
      )) {
        throw new Error(
          `source bundle ${participantId} forward state is incomplete`
        );
      }
    },
    stage: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      await completeMissingForwardLeaves(
        effect,
        effect.occurredAt,
        false
      );
      const readback = await inspect(effect);
      if (readback.status !== "source-deleted") {
        throw new Error(
          `source bundle ${participantId} forward readback mismatch`
        );
      }
      return readback.forwardReceipt;
    },
    restore: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      const observed = await inspectLeaves(effect);
      if (
        observed.some((leaf) => leaf.observation.status === "before")
      ) {
        throw new Error(
          `source bundle ${participantId} durable forward proof is incomplete`
        );
      }
      const forwardReceipt = aggregateForwardReceipt({
        identity: effect,
        participantId,
        recordKind,
        selectionDigest,
        rootBinding,
        leaves: observed
      });
      const expectedForward = parseRecordMutationSourceParticipantReceipt(
        effect.forwardReceipt
      );
      if (forwardReceipt.digest !== expectedForward.digest) {
        throw new Error(
          `source bundle ${participantId} forward receipt changed`
        );
      }
      for (const [index, leaf] of observed.entries()) {
        if (leaf.observation.status === "source-restored") continue;
        if (leaf.observation.status !== "source-deleted") {
          throw new Error(
            `source bundle leaf ${leaf.adapter.participantId} forward proof is missing`
          );
        }
        const leafIdentity = {
          mutationId: effect.mutationId,
          conversationId: effect.conversationId,
          participantId: leaf.adapter.participantId
        };
        const leafForwardReceipt = leaf.observation.forwardReceipt;
        await withLeafMutation(leaf, async () => {
          const current = parseLeafObservation(
            await leaf.adapter.inspect(leafIdentity),
            leafIdentity,
            recordKind
          );
          if (current.status === "source-restored") return;
          if (
            current.status !== "source-deleted"
            || current.forwardReceipt.digest !== leafForwardReceipt.digest
          ) {
            throw new Error(
              `source bundle leaf ${leaf.adapter.participantId} forward receipt changed`
            );
          }
          await leaf.adapter.restore({
            ...leafIdentity,
            forwardReceipt: leafForwardReceipt,
            occurredAt: leafTimestamp(effect.occurredAt, index)
          });
          const readback = parseLeafObservation(
            await leaf.adapter.inspect(leafIdentity),
            leafIdentity,
            recordKind
          );
          if (
            readback.status !== "source-restored"
            || readback.forwardReceipt.digest !== leafForwardReceipt.digest
          ) {
            throw new Error(
              `source bundle leaf ${leaf.adapter.participantId} restore readback mismatch`
            );
          }
        });
      }
      const readback = await inspect(effect);
      if (
        readback.status !== "source-restored"
        || readback.forwardReceipt.digest !== forwardReceipt.digest
      ) {
        throw new Error(
          `source bundle ${participantId} restore readback mismatch`
        );
      }
      return readback.restoreReceipt;
    }
  };
}

function aggregateObservation(input: {
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  };
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  selectionDigest: string;
  rootBinding: RecordRootBindingRef;
  leaves: readonly ObservedSourceBundleLeaf[];
}): RecordMutationSourceParticipantObservation {
  if (input.leaves.every(
    (leaf) => leaf.observation.status === "before"
  )) {
    return { status: "before" };
  }
  if (input.leaves.some(
    (leaf) => leaf.observation.status === "before"
  )) {
    throw new Error(
      `source bundle ${input.participantId} partial forward requires reconciliation`
    );
  }
  const forwardReceipt = aggregateForwardReceipt(input);
  if (input.leaves.every(
    (leaf) => leaf.observation.status === "source-restored"
  )) {
    return {
      status: "source-restored",
      forwardReceipt,
      restoreReceipt: aggregateRestoreReceipt({
        ...input,
        forwardReceipt
      })
    };
  }
  // During a compensation crash, restored leaves retain their immutable
  // forward receipts. Treat the aggregate as forward-complete so restore()
  // can idempotently finish the remaining leaves before Journal publication.
  return { status: "source-deleted", forwardReceipt };
}

function aggregateForwardReceipt(input: {
  identity: {
    mutationId: string;
    conversationId: string;
  };
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  selectionDigest: string;
  rootBinding: RecordRootBindingRef;
  leaves: readonly ObservedSourceBundleLeaf[];
}): RecordMutationSourceParticipantReceipt {
  const leafReceipts = input.leaves.map((leaf) => {
    if (leaf.observation.status === "before") {
      throw new Error(
        `source bundle leaf ${leaf.adapter.participantId} forward receipt missing`
      );
    }
    return {
      subject: leaf.subject,
      subjectKey: leaf.subjectKey,
      participantId: leaf.adapter.participantId,
      receipt: parseRecordMutationSourceParticipantReceipt(
        leaf.observation.forwardReceipt
      )
    };
  });
  const effectDigest = recordMutationDigest({
    kind: "record-mutation-source-bundle-forward",
    mutationId: input.identity.mutationId,
    conversationId: input.identity.conversationId,
    participantId: input.participantId,
    recordKind: input.recordKind,
    selectionDigest: input.selectionDigest,
    rootBinding: input.rootBinding,
    leaves: leafReceipts.map((leaf) => ({
      subject: leaf.subject,
      subjectKey: leaf.subjectKey,
      participantId: leaf.participantId,
      receiptDigest: leaf.receipt.digest
    }))
  });
  return createRecordMutationSourceParticipantReceipt({
    mutationId: input.identity.mutationId,
    conversationId: input.identity.conversationId,
    participantId: input.participantId,
    recordKind: input.recordKind,
    phase: "source-deleted",
    effectId: bundleEffectId("source-deleted", effectDigest),
    effectDigest,
    occurredAt: Math.max(
      ...leafReceipts.map((leaf) => leaf.receipt.occurredAt)
    )
  });
}

function aggregateRestoreReceipt(input: {
  identity: {
    mutationId: string;
    conversationId: string;
  };
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  selectionDigest: string;
  rootBinding: RecordRootBindingRef;
  leaves: readonly ObservedSourceBundleLeaf[];
  forwardReceipt: RecordMutationSourceParticipantReceipt;
}): RecordMutationSourceParticipantReceipt {
  const leafReceipts = input.leaves.map((leaf) => {
    if (leaf.observation.status !== "source-restored") {
      throw new Error(
        `source bundle leaf ${leaf.adapter.participantId} restore receipt missing`
      );
    }
    return {
      subject: leaf.subject,
      subjectKey: leaf.subjectKey,
      participantId: leaf.adapter.participantId,
      receipt: parseRecordMutationSourceParticipantReceipt(
        leaf.observation.restoreReceipt
      )
    };
  });
  const effectDigest = recordMutationDigest({
    kind: "record-mutation-source-bundle-restore",
    mutationId: input.identity.mutationId,
    conversationId: input.identity.conversationId,
    participantId: input.participantId,
    recordKind: input.recordKind,
    selectionDigest: input.selectionDigest,
    rootBinding: input.rootBinding,
    forwardReceiptDigest: input.forwardReceipt.digest,
    leaves: leafReceipts.map((leaf) => ({
      subject: leaf.subject,
      subjectKey: leaf.subjectKey,
      participantId: leaf.participantId,
      receiptDigest: leaf.receipt.digest
    }))
  });
  return createRecordMutationSourceParticipantReceipt({
    mutationId: input.identity.mutationId,
    conversationId: input.identity.conversationId,
    participantId: input.participantId,
    recordKind: input.recordKind,
    phase: "source-restored",
    effectId: bundleEffectId("source-restored", effectDigest),
    effectDigest,
    occurredAt: Math.max(
      ...leafReceipts.map((leaf) => leaf.receipt.occurredAt)
    )
  });
}

function normalizeSubjects(
  input: readonly RecordMutationExecutionSubject[],
  recordKind: RecordMutationSourceParticipantKind
): RecordMutationExecutionSubject[] {
  if (!Array.isArray(input) || input.length < 1) {
    throw new Error("source bundle subjects are missing");
  }
  const subjects = input.map(cloneSubject);
  const subjectKeys = subjects.map((subject) => (
    stableRecordMutationStringify(subject)
  ));
  const sorted = [...subjectKeys].sort(compareText);
  if (
    subjects.some((subject) => subject.kind !== recordKind)
    || new Set(subjectKeys).size !== subjectKeys.length
    || subjectKeys.some((subjectKey, index) => subjectKey !== sorted[index])
  ) {
    throw new Error(
      "source bundle subjects must be unique and stably ordered"
    );
  }
  const leafIds = subjects.map(subjectParticipantId);
  if (new Set(leafIds).size !== leafIds.length) {
    throw new Error("source bundle semantic leaf identity is duplicated");
  }
  return subjects;
}

function normalizeLeaves(input: {
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  recordKind: RecordMutationSourceParticipantKind;
  subjects: readonly RecordMutationExecutionSubject[];
  leafAdapters: readonly RecordMutationSourceParticipantAdapter[];
}): SourceBundleLeaf[] {
  if (
    !Array.isArray(input.leafAdapters)
    || input.leafAdapters.length !== input.subjects.length
  ) {
    throw new Error(
      "source bundle leaf adapters must match subjects 完整同序"
    );
  }
  return input.subjects.map((subject, index) => {
    const adapter = input.leafAdapters[index];
    if (
      !adapter
      || adapter.participantId !== subjectParticipantId(subject)
    ) {
      throw new Error(
        "source bundle leaf adapters must match subjects 完整同序"
      );
    }
    const leaf = {
      subject,
      subjectKey: stableRecordMutationStringify(subject),
      adapter
    };
    assertLeafAdapterMatches({ leaf, ...input });
    return leaf;
  });
}

function assertLeafAdapterMatches(input: {
  leaf: SourceBundleLeaf;
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  recordKind: RecordMutationSourceParticipantKind;
}): void {
  const adapter = input.leaf.adapter;
  if (
    adapter.participantId !== subjectParticipantId(input.leaf.subject)
    || adapter.recordKind !== input.recordKind
    || path.resolve(adapter.storageRootPath) !== input.storageRootPath
    || path.resolve(adapter.rootPath) !== input.rootPath
    || path.resolve(adapter.boundaryRootPath) !== input.boundaryRootPath
    || !sameRecordRootBindingRef(adapter.rootBinding, input.rootBinding)
  ) {
    throw new Error(
      `source bundle leaf ${adapter.participantId} adapter binding mismatch`
    );
  }
}

function parseLeafObservation(
  input: RecordMutationSourceParticipantObservation,
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  recordKind: RecordMutationSourceParticipantKind
): RecordMutationSourceParticipantObservation {
  if (input.status === "before") return input;
  const forwardReceipt = parseRecordMutationSourceParticipantReceipt(
    input.forwardReceipt
  );
  assertLeafReceiptMatches(
    forwardReceipt,
    identity,
    recordKind,
    "source-deleted"
  );
  if (input.status === "source-deleted") {
    return { status: "source-deleted", forwardReceipt };
  }
  const restoreReceipt = parseRecordMutationSourceParticipantReceipt(
    input.restoreReceipt
  );
  assertLeafReceiptMatches(
    restoreReceipt,
    identity,
    recordKind,
    "source-restored"
  );
  return { status: "source-restored", forwardReceipt, restoreReceipt };
}

function assertLeafReceiptMatches(
  receipt: RecordMutationSourceParticipantReceipt,
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  recordKind: RecordMutationSourceParticipantKind,
  phase: RecordMutationSourceParticipantReceipt["phase"]
): void {
  if (
    receipt.mutationId !== identity.mutationId
    || receipt.conversationId !== identity.conversationId
    || receipt.participantId !== identity.participantId
    || receipt.recordKind !== recordKind
    || receipt.phase !== phase
  ) {
    throw new Error(
      `source bundle leaf ${identity.participantId} receipt identity mismatch`
    );
  }
}

function requireBundleParticipantId(
  value: string,
  recordKind: RecordMutationSourceParticipantKind,
  rootId: string,
  selectionDigest: string,
  subjects: RecordMutationExecutionSubject[]
): string {
  const expected = recordMutationExecutionBundleParticipantId({
    recordKind,
    action: "mark-source-deleted",
    execution: {
      kind: "source-deletion-bundle",
      rootId,
      selectionDigest,
      subjects
    }
  });
  if (value !== expected) {
    throw new Error("source bundle participant identity mismatch");
  }
  return value;
}

function subjectParticipantId(
  subject: RecordMutationExecutionSubject
): string {
  if (subject.kind === "workflow-run") {
    return workflowRunPayloadParticipantId(
      subject.workflowRunId,
      subject.attemptId
    );
  }
  return subject.kind === "memory"
    ? subject.memoryId
    : subject.artifactId;
}

function cloneSubject(
  subject: RecordMutationExecutionSubject
): RecordMutationExecutionSubject {
  return { ...subject };
}

function bundleEffectId(
  phase: "source-deleted" | "source-restored",
  effectDigest: string
): string {
  return `source-bundle-${phase}-${effectDigest.slice("sha256:".length, 31)}`;
}

function leafTimestamp(base: number, index: number): number {
  if (!Number.isSafeInteger(base) || base < 0) {
    throw new Error("source bundle occurredAt is invalid");
  }
  const timestamp = base + index;
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("source bundle occurredAt overflow");
  }
  return timestamp;
}

function requireBundleRecordKind(
  value: RecordMutationSourceParticipantKind
): RecordMutationSourceParticipantKind {
  if (
    value !== "workflow-run"
    && value !== "memory"
    && value !== "artifact"
  ) {
    throw new Error("source bundle recordKind is invalid");
  }
  return value;
}

function requireDigest(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`source bundle ${label} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw new Error(`source bundle ${label} is invalid`);
  }
  return path.resolve(value);
}

async function enqueueSourceBundleMutation<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = sourceBundleMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sourceBundleMutationTails.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (sourceBundleMutationTails.get(key) === tail) {
      sourceBundleMutationTails.delete(key);
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
