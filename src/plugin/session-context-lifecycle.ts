import {
  rotateSessionContext,
  type RotateSessionContextOptions,
  type SessionContextRotationResult
} from "../harness/conversation/context-rotation";
import type {
  ConversationMutationAuthority
} from "../harness/conversation/conversation-mutation-lane";
import {
  hasLegacyCodexThreadBindingConflict,
  workspaceFingerprint
} from "../harness/kernel/session-service";
import {
  hasLegacyWorkspaceMigrationPlaceholder
} from "../harness/lifecycle/legacy-workspace-migration-identity";
import {
  durableConversationContentRevisionForLiveSession
} from "../harness/lifecycle/conversation-migration-projection";
import type { StoredSession } from "../settings/settings";
import type { EchoInkHarnessService } from "./harness-service";
import type { EchoInkSettingsStore } from "./settings-store";

export type EchoInkSessionContextRotationOptions = Omit<
  RotateSessionContextOptions,
  "hooks" | "identityFactory" | "expectedContentRevision"
> & {
  /**
   * Rechecks UI/runtime state after this Conversation lane is acquired and
   * before the live snapshot is taken.
   */
  precondition?: () => void;
};

export type EchoInkSessionContextRotationResult = SessionContextRotationResult;

export interface EchoInkSessionContextWorkspace {
  vaultPath: string;
  cwd: string;
}

/**
 * Establishes the first durable Context identity for pre-Context-Rotation
 * conversations. It preserves the visible/history boundary, advances the
 * generation through the Conversation Store CAS, and retires every legacy
 * Native binding before a new binding may be created.
 */
export async function ensureEchoInkSessionContextIdentity(
  harnessService: EchoInkHarnessService,
  settingsStore: EchoInkSettingsStore,
  session: StoredSession,
  workspace: EchoInkSessionContextWorkspace
): Promise<EchoInkSessionContextRotationResult | null> {
  const contextId = session.contextId?.trim();
  const commitId = session.commitId?.trim();
  const storedWorkspaceFingerprint = session.workspaceFingerprint?.trim();
  const currentWorkspaceFingerprint = workspaceFingerprint(workspace);
  const hasMigrationPlaceholder = hasLegacyWorkspaceMigrationPlaceholder(session);
  if (
    storedWorkspaceFingerprint
    && storedWorkspaceFingerprint !== currentWorkspaceFingerprint
    && !hasMigrationPlaceholder
  ) {
    throw new Error(
      "Conversation recovery required: durable Context identity belongs to a different workspace"
    );
  }
  if (
    contextId
    && commitId
    && storedWorkspaceFingerprint
    && !hasMigrationPlaceholder
  ) {
    return null;
  }

  return await rotateEchoInkSessionContext(
    harnessService,
    settingsStore,
    session,
    {
      reason: "legacy-context-bootstrap",
      advanceContext: true,
      contextStartsAfterMessageId: session.contextStartsAfterMessageId ?? null,
      workspace
    }
  );
}

export async function rotateEchoInkSessionContext(
  harnessService: EchoInkHarnessService,
  settingsStore: EchoInkSettingsStore,
  session: StoredSession,
  options: EchoInkSessionContextRotationOptions
): Promise<EchoInkSessionContextRotationResult> {
  const rotate = async (authority: ConversationMutationAuthority) => {
    const { precondition, ...rotationOptions } = options;
    precondition?.();
    assertUnambiguousLegacyCodexThread(session);
    const durable = await settingsStore.readConversationSession(session.id);
    if (!durable) {
      throw new Error(
        `Conversation recovery required: conversation ${session.id} is missing`
      );
    }
    const expectedContentRevision =
      durableConversationContentRevisionForLiveSession(session, durable);
    const journalRequired = options.reason === "start-new-context"
      || options.reason === "history-restore"
      || options.reason === "agent-cache-reset";
    return await rotateSessionContext(session, {
      ...rotationOptions,
      expectedContentRevision,
      hooks: {
        ...(journalRequired
          ? {
            recordMutation: {
              stage: async (input) =>
                await settingsStore.stageSessionContextRecordMutation(input),
              settle: async (receipt) =>
                await settingsStore.settleSessionContextRecordMutation(
                  receipt,
                  authority
                )
            }
          }
          : {}),
        register: async (retirements) => {
          await harnessService.registerNativeExecutionRetirements(retirements);
        },
        commit: async (input) => {
          await settingsStore.commitConversationSessionContext(
            input.session,
            {
              expectedGeneration: input.expectedGeneration,
              expectedContentRevision: input.expectedContentRevision,
              ...(input.expectedCommitId
                ? { expectedCommitId: input.expectedCommitId }
                : {}),
              ...(options.reason === "history-restore"
                && input.recordMutationId
                ? { historyRestoreMutationId: input.recordMutationId }
                : {})
            }
          );
        },
        promote: async (retirements) => {
          await harnessService.promoteNativeExecutionRetirements(
            retirements,
            async (mutationId) =>
              await settingsStore.readRecordMutationAuthority(mutationId)
          );
        },
        abort: async (retirements, error) => {
          await harnessService.abortNativeExecutionRetirements(retirements, error.message);
        }
      }
    });
  };
  const rotation = await settingsStore.withConversationMutation(
    session.id,
    rotate
  );
  if (rotation.retirementPromotion === "promoted") {
    for (const retirement of rotation.retirements) {
      void harnessService.cleanupNativeExecutionRecord(retirement.retirementId)
        .catch((error) => {
          console.error(
            `EchoInk native retirement cleanup failed: ${retirement.retirementId}`,
            error
          );
        });
    }
  }
  return rotation;
}

function assertUnambiguousLegacyCodexThread(session: StoredSession): void {
  if (hasLegacyCodexThreadBindingConflict(session)) {
    throw new Error(
      "Conversation recovery required: legacy Codex thread conflicts with its backend binding"
    );
  }
}
