import {
  rotateSessionContext,
  type RotateSessionContextOptions,
  type SessionContextRotationResult
} from "../harness/conversation/context-rotation";
import { workspaceFingerprint } from "../harness/kernel/session-service";
import type { StoredSession } from "../settings/settings";
import type { EchoInkHarnessService } from "./harness-service";
import type { EchoInkSettingsStore } from "./settings-store";

export type EchoInkSessionContextRotationOptions = Omit<
  RotateSessionContextOptions,
  "hooks" | "identityFactory"
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
  if (
    storedWorkspaceFingerprint
    && storedWorkspaceFingerprint !== currentWorkspaceFingerprint
  ) {
    throw new Error(
      "Conversation recovery required: durable Context identity belongs to a different workspace"
    );
  }
  if (contextId && commitId && storedWorkspaceFingerprint) {
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
  const rotate = async () => {
    const { precondition, ...rotationOptions } = options;
    precondition?.();
    assertUnambiguousLegacyCodexThread(session);
    return await rotateSessionContext(session, {
      ...rotationOptions,
      hooks: {
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
                : {})
            }
          );
        },
        promote: async (retirements) => {
          await harnessService.promoteNativeExecutionRetirements(retirements);
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
  const legacyThreadId = session.threadId?.trim();
  const binding = session.backendBindings?.["codex-cli"];
  if (!legacyThreadId || !binding) return;
  const bindingThreadIds = new Set([
    binding.nativeThreadId?.trim(),
    binding.nativeExecutionRef?.kind === "thread"
      ? binding.nativeExecutionRef.id.trim()
      : ""
  ].filter(Boolean));
  if (
    bindingThreadIds.size > 1
    || (bindingThreadIds.size === 1 && !bindingThreadIds.has(legacyThreadId))
  ) {
    throw new Error(
      "Conversation recovery required: legacy Codex thread conflicts with its backend binding"
    );
  }
}
