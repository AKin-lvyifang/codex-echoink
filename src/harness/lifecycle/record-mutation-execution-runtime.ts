import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  sameRecordRootBindingRef,
  type RecordRootAuthority,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  coordinateRecordMutationTrashBundlePrepare,
  coordinateRecordMutationTrashPrepare
} from "./record-mutation-coordinator";
import {
  validateRecordMutationExecutionPlanAgainstJournal,
  type LoadedRecordMutationExecutionPlan,
  type RecordMutationExecutionParticipant
} from "./record-mutation-execution-plan";
import type {
  LoadedRecordMutationJournal
} from "./record-mutation-journal";
import type {
  RecordMutationRecoveryTrashParticipant
} from "./record-mutation-recovery-runner";
import type {
  RecordMutationSourceParticipantAdapter
} from "./record-mutation-source-participant";

export interface RecordMutationRuntimeRootDefinition {
  rootId: string;
  rootPath: string;
  boundaryRootPath: string;
  authority: RecordRootAuthority;
}

export interface RecordMutationRuntimeRoot {
  rootId: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
}

export interface RecordMutationSourceAdapterFactoryInput {
  journal: LoadedRecordMutationJournal;
  participant: Extract<
    RecordMutationExecutionParticipant,
    { action: "mark-source-deleted" }
  >;
  root: RecordMutationRuntimeRoot;
}

export type RecordMutationSourceAdapterFactory = (
  input: RecordMutationSourceAdapterFactoryInput
) => RecordMutationSourceParticipantAdapter;

export interface MaterializedRecordMutationExecution {
  journal: LoadedRecordMutationJournal;
  trashParticipants: RecordMutationRecoveryTrashParticipant[];
  sourceDeletedParticipants: RecordMutationSourceParticipantAdapter[];
}

export type RecordMutationExecutionRuntimeErrorCode =
  | "root_mismatch"
  | "plan_mismatch"
  | "bundle_runtime_required"
  | "adapter_required"
  | "adapter_mismatch";

export class RecordMutationExecutionRuntimeError extends Error {
  constructor(
    public readonly code: RecordMutationExecutionRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationExecutionRuntimeError";
  }
}

/**
 * Registers the physical roots before a destructive intent is created. The
 * returned refs are the only root authority that may be frozen into that
 * intent and its execution plan. This function never creates a source root;
 * a missing or unsafe root fails closed in the Root Registry.
 */
export async function registerRecordMutationRuntimeRoots(input: {
  storageRootPath: string;
  definitions: readonly RecordMutationRuntimeRootDefinition[];
  createdAt: number;
}): Promise<RecordMutationRuntimeRoot[]> {
  assertSortedUniqueDefinitions(input.definitions);
  const resolvedDefinitions: RecordMutationRuntimeRootDefinition[] = [];
  for (const definition of input.definitions) {
    resolvedDefinitions.push({
      ...definition,
      rootPath: path.resolve(await fsp.realpath(definition.rootPath)),
      boundaryRootPath: path.resolve(
        await fsp.realpath(definition.boundaryRootPath)
      )
    });
  }
  assertPhysicalRootsIndependent(resolvedDefinitions);
  const roots: RecordMutationRuntimeRoot[] = [];
  for (const definition of resolvedDefinitions) {
    const loaded = await createOrLoadRecordRootBinding({
      storageRootPath: input.storageRootPath,
      rootId: definition.rootId,
      rootPath: definition.rootPath,
      boundaryRootPath: definition.boundaryRootPath,
      authority: definition.authority,
      createdAt: input.createdAt
    });
    roots.push({
      rootId: loaded.binding.rootId,
      rootPath: definition.rootPath,
      boundaryRootPath: definition.boundaryRootPath,
      rootBinding: recordRootBindingRef(loaded.binding)
    });
  }
  return roots;
}

/**
 * Rebuilds the ephemeral Runner inputs only from the immutable plan, frozen
 * intent, current Root Registry bindings, and Store-specific adapter factory.
 * Trash prepare is idempotent and non-destructive, so this is safe both before
 * the live Conversation commit and after a restart.
 */
export async function materializeRecordMutationExecution(input: {
  plan: LoadedRecordMutationExecutionPlan;
  journal: LoadedRecordMutationJournal;
  roots: readonly RecordMutationRuntimeRoot[];
  createSourceAdapter?: RecordMutationSourceAdapterFactory;
  now?: () => number;
}): Promise<MaterializedRecordMutationExecution> {
  if (
    path.resolve(input.plan.handle.storageRootPath)
    !== path.resolve(input.journal.handle.storageRootPath)
  ) {
    throw runtimeError(
      "plan_mismatch",
      "execution plan 与 Journal storage root 不匹配"
    );
  }
  const plan = validateRecordMutationExecutionPlanAgainstJournal(
    input.plan.plan,
    input.journal
  );
  const unsupportedBundle = plan.participants.find((participant) => (
    participant.execution.kind === "retain-bundle"
  ));
  if (unsupportedBundle) {
    throw runtimeError(
      "bundle_runtime_required",
      `participant ${unsupportedBundle.participantId} bundle runtime 尚未接线`
    );
  }
  const roots = validateRuntimeRoots(input.journal, input.roots);
  const sourceDeletedParticipants: RecordMutationSourceParticipantAdapter[] = [];
  for (const participant of plan.participants) {
    if (
      participant.action !== "mark-source-deleted"
      || (
        participant.execution.kind !== "source-deletion"
        && participant.execution.kind !== "source-deletion-bundle"
      )
    ) {
      continue;
    }
    if (!input.createSourceAdapter) {
      throw runtimeError(
        "adapter_required",
        `participant ${participant.participantId} 缺少正式 Store adapter factory`
      );
    }
    const root = requireRuntimeRoot(roots, participant.execution.rootId);
    const adapter = input.createSourceAdapter({
      journal: input.journal,
      participant,
      root
    });
    assertAdapterMatchesPlan(
      adapter,
      participant,
      root,
      input.journal.handle.storageRootPath
    );
    sourceDeletedParticipants.push(adapter);
  }

  let current = input.journal;
  const trashParticipants: RecordMutationRecoveryTrashParticipant[] = [];

  for (const participant of plan.participants) {
    if (
      participant.execution.kind !== "trash"
      && participant.execution.kind !== "trash-bundle"
    ) {
      continue;
    }
    const source = requireRuntimeRoot(
      roots,
      participant.execution.sourceRootId
    );
    const trash = requireRuntimeRoot(
      roots,
      participant.execution.trashRootId
    );
    if (participant.execution.kind === "trash-bundle") {
      const prepared = await coordinateRecordMutationTrashBundlePrepare({
        journal: current,
        participantId: participant.participantId,
        selectionDigest: participant.execution.selectionDigest,
        items: participant.execution.items,
        storageRootPath: current.handle.storageRootPath,
        sourceRootPath: source.rootPath,
        sourceBoundaryRootPath: source.boundaryRootPath,
        sourceRootBinding: source.rootBinding,
        trashRootPath: trash.rootPath,
        trashBoundaryRootPath: trash.boundaryRootPath,
        trashRootBinding: trash.rootBinding,
        now: input.now
      });
      current = prepared.journal;
      trashParticipants.push({
        kind: "bundle",
        participantId: participant.participantId,
        selectionDigest: participant.execution.selectionDigest,
        items: participant.execution.items.map((item) => ({ ...item })),
        storageRootPath: current.handle.storageRootPath,
        sourceRootPath: source.rootPath,
        sourceBoundaryRootPath: source.boundaryRootPath,
        sourceRootBinding: source.rootBinding,
        trashRootPath: trash.rootPath,
        trashBoundaryRootPath: trash.boundaryRootPath,
        trashRootBinding: trash.rootBinding,
        preparedReceipt: prepared.preparedReceipt,
        leafReceipts: prepared.leafReceipts
      });
      continue;
    }
    const prepared = await coordinateRecordMutationTrashPrepare({
      journal: current,
      participantId: participant.participantId,
      sourceRelativePath: participant.execution.sourceRelativePath,
      storageRootPath: current.handle.storageRootPath,
      sourceRootPath: source.rootPath,
      sourceBoundaryRootPath: source.boundaryRootPath,
      sourceRootBinding: source.rootBinding,
      trashRootPath: trash.rootPath,
      trashBoundaryRootPath: trash.boundaryRootPath,
      trashRootBinding: trash.rootBinding,
      now: input.now
    });
    current = prepared.journal;
    trashParticipants.push({
      participantId: participant.participantId,
      storageRootPath: current.handle.storageRootPath,
      sourceRootPath: source.rootPath,
      sourceBoundaryRootPath: source.boundaryRootPath,
      sourceRootBinding: source.rootBinding,
      trashRootPath: trash.rootPath,
      trashBoundaryRootPath: trash.boundaryRootPath,
      trashRootBinding: trash.rootBinding,
      receipt: prepared.preparedReceipt
    });
  }

  return {
    journal: current,
    trashParticipants,
    sourceDeletedParticipants
  };
}

function validateRuntimeRoots(
  journal: LoadedRecordMutationJournal,
  input: readonly RecordMutationRuntimeRoot[]
): Map<string, RecordMutationRuntimeRoot> {
  const sorted = [...input].sort(
    (left, right) => left.rootId.localeCompare(right.rootId)
  );
  if (
    sorted.length !== input.length
    || input.some((root, index) => root !== sorted[index])
    || new Set(input.map((root) => root.rootId)).size !== input.length
  ) {
    throw runtimeError(
      "root_mismatch",
      "runtime roots 必须唯一且按 rootId 排序"
    );
  }
  const frozen = journal.record.intent.rootBindings;
  if (
    frozen.length !== input.length
    || input.some((root, index) => (
      root.rootId !== frozen[index]?.rootId
      || root.rootBinding.rootId !== root.rootId
      || !sameRecordRootBindingRef(root.rootBinding, frozen[index])
    ))
  ) {
    throw runtimeError(
      "root_mismatch",
      "runtime roots 与 intent Root Binding 不完整同序"
    );
  }
  for (const root of input) {
    requireAbsolutePath(root.rootPath, `${root.rootId}.rootPath`);
    requireAbsolutePath(
      root.boundaryRootPath,
      `${root.rootId}.boundaryRootPath`
    );
  }
  assertPhysicalRootsIndependent(input);
  return new Map(input.map((root) => [root.rootId, root]));
}

function assertAdapterMatchesPlan(
  adapter: RecordMutationSourceParticipantAdapter,
  participant: Extract<
    RecordMutationExecutionParticipant,
    { action: "mark-source-deleted" }
  >,
  root: RecordMutationRuntimeRoot,
  storageRootPath: string
): void {
  if (
    adapter.participantId !== participant.participantId
    || adapter.recordKind !== participant.recordKind
    || path.resolve(adapter.storageRootPath) !== path.resolve(storageRootPath)
    || path.resolve(adapter.rootPath) !== path.resolve(root.rootPath)
    || path.resolve(adapter.boundaryRootPath)
      !== path.resolve(root.boundaryRootPath)
    || !sameRecordRootBindingRef(adapter.rootBinding, root.rootBinding)
  ) {
    throw runtimeError(
      "adapter_mismatch",
      `participant ${participant.participantId} adapter 与 execution plan 不匹配`
    );
  }
}

function requireRuntimeRoot(
  roots: ReadonlyMap<string, RecordMutationRuntimeRoot>,
  rootId: string
): RecordMutationRuntimeRoot {
  const root = roots.get(rootId);
  if (!root) {
    throw runtimeError(
      "root_mismatch",
      `runtime root 缺失：${rootId}`
    );
  }
  return root;
}

function assertSortedUniqueDefinitions(
  definitions: readonly RecordMutationRuntimeRootDefinition[]
): void {
  if (definitions.length < 2) {
    throw runtimeError(
      "root_mismatch",
      "runtime root definitions 数量非法"
    );
  }
  const rootIds = definitions.map((definition) => definition.rootId);
  const sorted = [...rootIds].sort((left, right) => left.localeCompare(right));
  if (
    new Set(rootIds).size !== rootIds.length
    || rootIds.some((rootId, index) => rootId !== sorted[index])
  ) {
    throw runtimeError(
      "root_mismatch",
      "runtime root definitions 必须唯一且按 rootId 排序"
    );
  }
}

function assertPhysicalRootsIndependent(
  roots: readonly Pick<RecordMutationRuntimeRoot, "rootId" | "rootPath">[]
): void {
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex];
    const leftPath = path.resolve(left.rootPath);
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const right = roots[rightIndex];
      const rightPath = path.resolve(right.rootPath);
      if (
        leftPath === rightPath
        || isStrictDescendant(leftPath, rightPath)
        || isStrictDescendant(rightPath, leftPath)
      ) {
        throw runtimeError(
          "root_mismatch",
          `runtime roots 不能相同或嵌套：${left.rootId}/${right.rootId}`
        );
      }
    }
  }
}

function isStrictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(
    relative
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function requireAbsolutePath(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw runtimeError("root_mismatch", `${label} 非法`);
  }
}

function runtimeError(
  code: RecordMutationExecutionRuntimeErrorCode,
  message: string
): RecordMutationExecutionRuntimeError {
  return new RecordMutationExecutionRuntimeError(code, message);
}
