import { lstat } from "node:fs/promises";
import * as path from "node:path";
import {
  loadWorkflowArtifactLifecycleRecord
} from "../artifacts/artifact-lifecycle-store";
import type {
  RunRecordRetentionHoldReason
} from "../contracts/run-record";
import {
  listRecordMutationJournals
} from "../lifecycle/record-mutation-journal";
import {
  withRecordMutationGlobalAuthority
} from "../lifecycle/record-mutation-coordinator";
import {
  listMaintenanceWorkflowWals
} from "../maintenance/workflow-wal";
import {
  runRecordRetentionSubjectKey,
  type RunRecordRetentionHoldSnapshot,
  type RunRecordRetentionRecoveryEvidenceAuthority
} from "./run-record-retention";
import {
  FileRunRecordStore,
  type RunRecordStoreInventory
} from "./run-record-store";

const RETENTION_EVIDENCE_AUTHORITY_ID =
  "run-record-retention-recovery-evidence";

export interface RunRecordRetentionRecoveryEvidenceAuthorityInput {
  storageRootPath: string;
  artifactRootPath: string;
}

/**
 * Production recovery-evidence authority.
 *
 * The global RecordMutation authority freezes destructive product mutations,
 * maintenance WAL publication/state changes, and Artifact lineage changes.
 * The Run Store mutation lane simultaneously freezes summary/payload
 * publication. The hold snapshot therefore remains valid for the complete
 * retention callback, including its irreversible Trash retirement effects.
 */
export function createRunRecordRetentionRecoveryEvidenceAuthority(
  input: RunRecordRetentionRecoveryEvidenceAuthorityInput
): RunRecordRetentionRecoveryEvidenceAuthority {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const artifactRootPath = requireAbsolutePath(
    input.artifactRootPath,
    "artifactRootPath"
  );
  const store = new FileRunRecordStore({ storageRootPath });
  return {
    async withStableHolds<T>(
      action: (holds: RunRecordRetentionHoldSnapshot) => Promise<T>
    ): Promise<T> {
      return await withRecordMutationGlobalAuthority(
        storageRootPath,
        RETENTION_EVIDENCE_AUTHORITY_ID,
        async () => await store.withMutation(async () => {
          const inventory = await store.inventoryRunRecords();
          const holds = await collectRecoveryEvidenceHolds({
            storageRootPath,
            artifactRootPath,
            inventory
          });
          return await action(holds);
        })
      );
    }
  };
}

async function collectRecoveryEvidenceHolds(input: {
  storageRootPath: string;
  artifactRootPath: string;
  inventory: RunRecordStoreInventory;
}): Promise<RunRecordRetentionHoldSnapshot> {
  const holds = new Map<string, Set<RunRecordRetentionHoldReason>>();
  const workflowByConversation = new Map<string, string[]>();
  for (const workflow of input.inventory.workflowRuns) {
    const conversationId = workflow.summary.conversationRef?.conversationId;
    if (!conversationId) continue;
    const workflowRunIds = workflowByConversation.get(conversationId) ?? [];
    workflowRunIds.push(workflow.summary.workflowRunId);
    workflowByConversation.set(conversationId, workflowRunIds);
  }

  const wals = await listMaintenanceWorkflowWals(input.storageRootPath);
  for (const entry of wals) {
    if (entry.status === "invalid") {
      throw new Error(
        "Run retention recovery evidence found a corrupt maintenance WAL"
      );
    }
    if (
      entry.status === "ready"
      && entry.wal.state.phase === "finalized"
    ) {
      continue;
    }
    addWorkflowHold(
      holds,
      entry.wal.intent.workflowRunId,
      entry.status === "blocked" ? "wal-blocked" : "wal-present"
    );
  }

  const mutations = await listRecordMutationJournals(
    input.storageRootPath
  );
  for (const journal of mutations) {
    if (
      journal.record.state === "committed"
      || journal.record.state === "aborted"
    ) {
      continue;
    }
    for (
      const workflowRunId
      of workflowByConversation.get(
        journal.record.intent.conversationId
      ) ?? []
    ) {
      addWorkflowHold(
        holds,
        workflowRunId,
        "local-commit-recovery-required"
      );
    }
  }

  const artifactRootExists = await regularDirectoryExists(
    input.artifactRootPath
  );
  for (const workflow of input.inventory.workflowRuns) {
    if (
      workflow.summaryTombstone
      || workflow.summary.artifactRefs.length === 0
    ) {
      continue;
    }
    const conversationId = workflow.summary.conversationRef?.conversationId;
    for (const artifact of workflow.summary.artifactRefs) {
      if (!artifactRootExists || !conversationId) {
        addWorkflowHold(
          holds,
          workflow.summary.workflowRunId,
          "artifact-lineage-pending"
        );
        continue;
      }
      const lifecycle = await loadWorkflowArtifactLifecycleRecord(
        input.artifactRootPath,
        artifact.artifactId
      );
      if (
        !lifecycle
        || lifecycle.chain[0]?.artifactKind !== artifact.kind
        || !lifecycle.record.sourceConversationIds.includes(conversationId)
      ) {
        addWorkflowHold(
          holds,
          workflow.summary.workflowRunId,
          "artifact-lineage-pending"
        );
      }
    }
  }

  return freezeHoldSnapshot(holds);
}

function addWorkflowHold(
  holds: Map<string, Set<RunRecordRetentionHoldReason>>,
  workflowRunId: string,
  reason: RunRecordRetentionHoldReason
): void {
  const key = runRecordRetentionSubjectKey({
    scope: "workflow-summary",
    workflowRunId
  });
  const reasons = holds.get(key) ?? new Set<RunRecordRetentionHoldReason>();
  reasons.add(reason);
  holds.set(key, reasons);
}

function freezeHoldSnapshot(
  holds: ReadonlyMap<string, ReadonlySet<RunRecordRetentionHoldReason>>
): RunRecordRetentionHoldSnapshot {
  const snapshot: Record<string, readonly RunRecordRetentionHoldReason[]> = {};
  for (const key of [...holds.keys()].sort(compareText)) {
    snapshot[key] = Object.freeze(
      [...(holds.get(key) ?? [])].sort(compareText)
    );
  }
  return Object.freeze(snapshot);
}

async function regularDirectoryExists(rootPath: string): Promise<boolean> {
  const stat = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "Run retention Artifact lifecycle root is not a safe directory"
    );
  }
  return true;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw new Error(`Run retention recovery evidence ${label} is invalid`);
  }
  return path.resolve(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
