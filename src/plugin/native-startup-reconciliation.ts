import type {
  ConversationAuthorityProbe,
  ConversationAuthorityProof
} from "../harness/conversation/conversation-store";
import {
  nativeCleanupAuthorityEvidenceMissingReason,
  nativeRetirementSourceIdentityState,
  type NativeBindingRetirement,
  type NativeExecutionRecord
} from "../harness/contracts/native-execution";
import type { NativeCleanupResult } from "../harness/native/native-execution-manager";

export const DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT = 20;
const MAX_STARTUP_NATIVE_CLEANUP_LIMIT = 100;

export type NativeRetirementStartupAction =
  | "promoted"
  | "aborted"
  | "quarantined";

export interface NativeRetirementStartupResult {
  recordId: string;
  action: NativeRetirementStartupAction;
  proof?: ConversationAuthorityProof;
  reason?: string;
}

export interface NativeStartupReconciliationResult {
  recoveredPendingChatCount: number;
  recoveredPendingHermesProposalCount: number;
  awaitingCount: number;
  promotedCount: number;
  abortedCount: number;
  quarantinedCount: number;
  retirements: NativeRetirementStartupResult[];
  cleanup: NativeCleanupResult[];
}

export interface NativeStartupReconciliationHost {
  recoverPendingChatLocalCommits?(): Promise<number>;
  recoverPendingEditorLocalCommits?(): Promise<void>;
  recoverPendingEphemeralUtilityLocalCommits?(): Promise<void>;
  recoverPendingHermesProposalLocalCommits?(): Promise<number>;
  listAwaitingRetirements(): Promise<NativeExecutionRecord[]>;
  proveConversationAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof>;
  promoteRetirement(record: NativeExecutionRecord): Promise<void>;
  abortRetirement(record: NativeExecutionRecord, reason: string): Promise<void>;
  quarantineRetirement(record: NativeExecutionRecord, reason: string): Promise<void>;
  cleanupDue(limit: number): Promise<NativeCleanupResult[]>;
}

export interface NativeStartupReconciliationOptions {
  cleanupLimit?: number;
}

/**
 * Reconciles durable retirement records before allowing any provider cleanup.
 *
 * Store/schema failures are deliberately allowed to reject this function. In
 * that case cleanupDue is never reached, so no provider disposition can run
 * from incomplete or future authority.
 */
export async function reconcileNativeExecutionsAtStartup(
  host: NativeStartupReconciliationHost,
  options: NativeStartupReconciliationOptions = {}
): Promise<NativeStartupReconciliationResult> {
  // A provider disposition must never race ahead of an unproven Chat surface
  // commit. This recovery step is deliberately first and fail-closed: Store
  // errors reject the whole startup pass before retirement promotion or
  // cleanupDue can reach a backend.
  const recoveredPendingChatCount =
    await host.recoverPendingChatLocalCommits?.() ?? 0;
  // Editor Native records use the Run Ledger terminal as their durable local
  // commit authority. Reconcile them inside the same global startup gate so a
  // pending registration can never fall through into cleanupDue().
  await host.recoverPendingEditorLocalCommits?.();
  // Prompt Enhancer uses its Run Ledger surface terminal. Memory Curator must
  // additionally recover and prove its formal Memory transaction; a terminal
  // alone never authorizes cleanup. Both settle before cleanupDue while
  // remaining isolated from Chat's workflow-specific recovery pass.
  await host.recoverPendingEphemeralUtilityLocalCommits?.();
  // Hermes maintenance proposals use an EchoInk-owned process identity. Their
  // Run Ledger and host-process disposition receipt must be reconciled before
  // the global cleanup gate opens; neither proof is sufficient on its own.
  const recoveredPendingHermesProposalCount =
    await host.recoverPendingHermesProposalLocalCommits?.() ?? 0;
  // Despite the legacy host method name, this list contains every retirement
  // that can still reach provider cleanup: awaiting, pending, and failed.
  // Pending/failed records must be re-proven after restart rather than trusted
  // merely because an earlier process promoted them.
  const awaiting = await host.listAwaitingRetirements();
  const retirements: NativeRetirementStartupResult[] = [];

  for (const record of awaiting) {
    const retirement = record.retirement;
    if (!retirement) {
      const reason = nativeCleanupAuthorityEvidenceMissingReason(record.id);
      await host.quarantineRetirement(record, reason);
      throw new Error(reason);
    }
    const sourceIdentityState =
      nativeRetirementSourceIdentityState(retirement);
    if (sourceIdentityState === "invalid") {
      const reason = (
        `Native retirement source identity is partial or invalid: ${record.id}`
      );
      await host.quarantineRetirement(record, reason);
      throw new Error(reason);
    }

    let proof: ConversationAuthorityProof;
    try {
      proof = await host.proveConversationAuthority({
        conversationId: retirement.targetConversationId,
        targetGeneration: retirement.targetGeneration,
        targetCommitId: retirement.targetCommitId,
        ...(retirement.targetContextId
          ? { targetContextId: retirement.targetContextId }
          : {}),
        ...(retirement.targetWorkspaceFingerprint
          ? { targetWorkspaceFingerprint: retirement.targetWorkspaceFingerprint }
          : {})
      });
    } catch (error) {
      const reason = `Conversation authority proof failed: ${errorMessage(error)}`;
      await host.quarantineRetirement(record, reason);
      // Unknown/corrupt authority is a Store-wide cleanup gate. Quarantine the
      // affected retirement for evidence, then reject before cleanupDue() can
      // touch this or any unrelated provider execution.
      throw new Error(reason);
    }

    if (proof.relation === "exact" && proof.targetPayload === "active") {
      await host.promoteRetirement(record);
      retirements.push({ recordId: record.id, action: "promoted", proof });
      continue;
    }
    const sourceAuthorityExact = sourceIdentityState === "complete"
      && proof.targetPayload === "absent"
      && conversationProofMatchesRetirementSource(proof, retirement);
    if (
      (
        (
          proof.relation === "before"
          && (
            sourceIdentityState === "legacy"
            || sourceAuthorityExact
          )
        )
        || (
          proof.relation === "conflict"
          && sourceAuthorityExact
        )
      )
      && proof.targetPayload === "absent"
      && record.cleanup === "awaiting-local-commit"
    ) {
      const reason = sourceAuthorityExact
        ? "Conversation remains at the exact source of the uncommitted retirement target"
        : "Conversation remains before the uncommitted retirement target";
      await host.abortRetirement(record, reason);
      retirements.push({ recordId: record.id, action: "aborted", proof, reason });
      continue;
    }

    const reason = (
      `Conversation authority is ${proof.relation}/${proof.targetPayload}; `
      + "Native cleanup is quarantined"
    );
    await host.quarantineRetirement(record, reason);
    retirements.push({ recordId: record.id, action: "quarantined", proof, reason });
  }

  const cleanup = await host.cleanupDue(startupCleanupLimit(options.cleanupLimit));
  return {
    recoveredPendingChatCount,
    recoveredPendingHermesProposalCount,
    awaitingCount: awaiting.length,
    promotedCount: countActions(retirements, "promoted"),
    abortedCount: countActions(retirements, "aborted"),
    quarantinedCount: countActions(retirements, "quarantined"),
    retirements,
    cleanup
  };
}

function conversationProofMatchesRetirementSource(
  proof: ConversationAuthorityProof,
  retirement: NativeBindingRetirement
): boolean {
  return (
    proof.currentGeneration === retirement.sourceGeneration
    && normalizedOptionalIdentity(proof.currentCommitId)
      === normalizedNullableIdentity(retirement.sourceCommitId)
    && normalizedOptionalIdentity(proof.currentContextId)
      === normalizedNullableIdentity(retirement.sourceContextId)
    && normalizedOptionalIdentity(proof.currentWorkspaceFingerprint)
      === normalizedNullableIdentity(retirement.sourceWorkspaceFingerprint)
  );
}

function normalizedOptionalIdentity(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizedNullableIdentity(
  value: string | null | undefined
): string | null {
  return value?.trim() || null;
}

function startupCleanupLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT;
  return Math.min(
    MAX_STARTUP_NATIVE_CLEANUP_LIMIT,
    Math.max(0, Math.floor(value))
  );
}

function countActions(
  results: readonly NativeRetirementStartupResult[],
  action: NativeRetirementStartupAction
): number {
  return results.filter((result) => result.action === action).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
