import { randomUUID } from "node:crypto";
import {
  createConversationContentRevision,
  createConversationDeletionTombstone,
  type ConversationDeletionTombstoneV1
} from "../harness/conversation/conversation-store";
import {
  createSessionDeletionRetirements,
  createSessionRecordClearRetirements,
  type SessionNativeRetirement
} from "../harness/conversation/context-rotation";
import { sessionGeneration } from "../harness/kernel/session-service";
import {
  createRecordMutationExecutionPlan
} from "../harness/lifecycle/record-mutation-execution-plan";
import {
  materializeRecordMutationExecution
} from "../harness/lifecycle/record-mutation-execution-runtime";
import {
  createRecordMutationJournal
} from "../harness/lifecycle/record-mutation-journal";
import {
  withRecordMutationGlobalAuthority
} from "../harness/lifecycle/record-mutation-coordinator";
import type {
  RecordMutationRecoveryRunnerResult
} from "../harness/lifecycle/record-mutation-recovery-runner";
import {
  createEchoInkRecordMutationSourceAdapterFactory,
  prepareEchoInkRecordMutationRuntimeRoots
} from "../harness/lifecycle/record-mutation-production";
import {
  inventoryConversationRecords,
  type ConversationRecordInventory,
  type ConversationRecordInventoryBlocker
} from "../harness/records/conversation-record-inventory";
import {
  buildConversationRecordMutationPlan,
  conversationRecordMutationRequiredRootIds
} from "../harness/records/conversation-record-mutation-plan";
import {
  createEchoInkRecordMutationSelectionVerifier
} from "../harness/records/conversation-record-mutation-selection-verifier";
import { pluginDataDir } from "../core/raw-message-store";
import type { StoredSession } from "../settings/settings";
import type { EchoInkHarnessService } from "./harness-service";
import {
  ensureEchoInkSessionContextIdentity
} from "./session-context-lifecycle";
import type { EchoInkSettingsStore } from "./settings-store";

export type ConversationRecordMutationOperation =
  | "clear-conversation-records"
  | "delete-conversation";

export interface ConversationRecordMutationDisposition {
  retainMemoryIds: string[];
  retainArtifactIds: string[];
}

export interface ConversationRecordMutationPreview {
  operation: ConversationRecordMutationOperation;
  conversationId: string;
  inventorySnapshotDigest: string;
  disposition: ConversationRecordMutationDisposition;
  blockers: ConversationRecordInventoryBlocker[];
}

export interface ConversationRecordMutationReceipt {
  operation: ConversationRecordMutationOperation;
  conversationId: string;
  mutationId: string;
  localState: "committed" | "aborted" | "awaiting-recovery";
  projection: "updated" | "awaiting-recovery";
  nativeRetirement:
    | "not-required"
    | "promoted"
    | "awaiting-recovery"
    | "aborted";
  nativeRetirementIds: string[];
  error?: string;
}

export class ConversationRecordMutationLifecycleError extends Error {
  constructor(
    public readonly code:
      | "inventory_blocked"
      | "conversation_changed"
      | "local_commit_aborted",
    message: string,
    public readonly mutationId?: string
  ) {
    super(message);
    this.name = "ConversationRecordMutationLifecycleError";
  }
}

export interface ConversationRecordMutationPluginHost {
  settings: {
    sessions: StoredSession[];
  };
  getVaultPath(): string;
  getPluginDataDirName(): string;
}

export async function previewEchoInkConversationRecordMutation(
  plugin: ConversationRecordMutationPluginHost,
  session: StoredSession,
  operation: ConversationRecordMutationOperation
): Promise<ConversationRecordMutationPreview> {
  assertAuthoritativeLiveSession(plugin, session);
  const inventory = await inventoryConversationRecords({
    operation,
    conversationId: session.id,
    conversations: cloneSessions(plugin.settings.sessions),
    vaultPath: plugin.getVaultPath(),
    pluginDir: plugin.getPluginDataDirName()
  });
  return {
    operation,
    conversationId: session.id,
    inventorySnapshotDigest: inventory.snapshotDigest,
    disposition: {
      retainMemoryIds: inventory.memory?.subjects
        .filter((subject) => subject.action === "requires-explicit-choice")
        .map((subject) => subject.memoryId) ?? [],
      retainArtifactIds: inventory.artifacts?.subjects
        .filter((subject) => subject.action === "requires-explicit-choice")
        .map((subject) => subject.artifactId) ?? []
    },
    blockers: inventory.blockers.filter(
      (blocker) =>
        blocker.code !== "memory-confirmation-disposition-required"
        && blocker.code !== "artifact-disposition-required"
    )
  };
}

export async function commitEchoInkConversationRecordMutation(input: {
  plugin: ConversationRecordMutationPluginHost;
  settingsStore: EchoInkSettingsStore;
  harnessService: EchoInkHarnessService;
  session: StoredSession;
  operation: ConversationRecordMutationOperation;
  disposition: ConversationRecordMutationDisposition;
  now?: () => number;
}): Promise<ConversationRecordMutationReceipt> {
  const {
    plugin,
    settingsStore,
    harnessService,
    session,
    operation
  } = input;
  assertAuthoritativeLiveSession(plugin, session);
  await settingsStore.ensureConversationSessionCreated(session);
  await ensureEchoInkSessionContextIdentity(
    harnessService,
    settingsStore,
    session,
    {
      vaultPath: plugin.getVaultPath(),
      cwd: session.cwd || plugin.getVaultPath()
    }
  );
  await settingsStore.ensureConversationSessionCreated(session);

  return await settingsStore.withConversationMutation(
    session.id,
    async (authority) => {
      const createdAt = input.now?.() ?? Date.now();
      const mutationId = `conversation-mutation-${randomUUID()}`;
      const storageRootPath = pluginDataDir(
        plugin.getVaultPath(),
        plugin.getPluginDataDirName()
      );
      return await withRecordMutationGlobalAuthority(
        storageRootPath,
        mutationId,
        async () => {
          assertAuthoritativeLiveSession(plugin, session);
          const sourceSession = cloneSession(session);
          const expectedGeneration = sessionGeneration(sourceSession);
          const expectedCommitId = sourceSession.commitId?.trim();
          const expectedContentRevision =
            createConversationContentRevision(sourceSession);
          if (!expectedCommitId) {
            throw new ConversationRecordMutationLifecycleError(
              "conversation_changed",
              "Conversation destructive mutation requires a durable commit identity"
            );
          }
          const durable = await settingsStore.readConversationSession(session.id);
          if (
            !durable
            || createConversationContentRevision(durable)
              !== expectedContentRevision
          ) {
            throw new ConversationRecordMutationLifecycleError(
              "conversation_changed",
              "Conversation changed before destructive inventory"
            );
          }

          const conversationSources =
            await settingsStore.planConversationRecordMutationSources({
              operation,
              conversationId: session.id,
              expectedGeneration,
              expectedCommitId,
              expectedContentRevision
            }, authority);
          const inventoryInput = {
            operation,
            conversationId: session.id,
            vaultPath: plugin.getVaultPath(),
            pluginDir: plugin.getPluginDataDirName(),
            decisions: {
              retainMemoryIds: [...input.disposition.retainMemoryIds],
              retainArtifactIds: [...input.disposition.retainArtifactIds]
            }
          } as const;
          const firstInventory = await inventoryConversationRecords({
            ...inventoryInput,
            conversations: cloneSessions(plugin.settings.sessions)
          });
          const secondInventory = await inventoryConversationRecords({
            ...inventoryInput,
            conversations: cloneSessions(plugin.settings.sessions)
          });
          assertStableReadyInventory(firstInventory, secondInventory);

          const target = createConversationTarget({
            operation,
            sourceSession,
            mutationId,
            now: createdAt
          });
          const conversationRoute =
            await settingsStore.resolveConversationRecordMutationRoute();
          const requiredRootIds =
            conversationRecordMutationRequiredRootIds(
              secondInventory,
              conversationRoute.rootId
            );
          const preparedRoots =
            await prepareEchoInkRecordMutationRuntimeRoots({
              vaultPath: plugin.getVaultPath(),
              pluginDir: plugin.getPluginDataDirName(),
              rootIds: requiredRootIds,
              createdAt,
              conversationRootPath: conversationRoute.rootPath
            });
          const built = buildConversationRecordMutationPlan({
            inventory: secondInventory,
            conversationSources,
            expectedConversationGeneration: expectedGeneration,
            expectedConversationCommitId: expectedCommitId,
            expectedConversationContentRevision: expectedContentRevision,
            targetConversation: target.intentTarget,
            rootBindings: preparedRoots.roots.map((root) => root.rootBinding),
            conversationRootId: conversationRoute.rootId,
            conversationStoreVersion: conversationRoute.storeVersion
          });
          const journal = await createRecordMutationJournal({
            storageRootPath: preparedRoots.storageRootPath,
            mutationId,
            intent: built.intent,
            createdAt
          });
          const executionPlan = await createRecordMutationExecutionPlan({
            journal,
            participants: built.executionParticipants,
            createdAt: createdAt + 1
          });
          const materialized = await materializeRecordMutationExecution({
            plan: executionPlan,
            journal,
            roots: preparedRoots.roots,
            createSourceAdapter:
              createEchoInkRecordMutationSourceAdapterFactory({
                vaultPath: plugin.getVaultPath()
              }),
            verifyFrozenSelection:
              createEchoInkRecordMutationSelectionVerifier({
                vaultPath: plugin.getVaultPath(),
                pluginDir: plugin.getPluginDataDirName(),
                getConversations: () => plugin.settings.sessions
              }),
            now: input.now
          });
          const retirements = createNativeRetirements({
            operation,
            sourceSession,
            target,
            mutationId
          });

          let targetCommitError: Error | null = null;
          try {
            if (retirements.length) {
              await harnessService.registerNativeExecutionRetirements(
                retirements
              );
            }
            if (operation === "delete-conversation") {
              await settingsStore.commitConversationDeletionTombstone(
                target.tombstone!,
                {
                  expectedGeneration,
                  expectedCommitId,
                  expectedContentRevision,
                  sourceRelativePaths: conversationSources.map(
                    (source) => source.sourceRelativePath
                  )
                },
                authority
              );
            } else {
              await settingsStore.commitConversationRecordClear(
                target.session!,
                {
                  mutationId,
                  expectedGeneration,
                  expectedCommitId,
                  expectedContentRevision,
                  sourceRelativePaths: conversationSources.map(
                    (source) => source.sourceRelativePath
                  )
                },
                authority
              );
            }
          } catch (error) {
            targetCommitError = asError(error);
          }

          let recovery: RecordMutationRecoveryRunnerResult;
          try {
            recovery =
              await settingsStore.settleConversationRecordMutationExecution(
                materialized,
                authority
              );
          } catch (error) {
            return {
              operation,
              conversationId: session.id,
              mutationId,
              localState: "awaiting-recovery",
              projection: "awaiting-recovery",
              nativeRetirement: retirements.length
                ? "awaiting-recovery"
                : "not-required",
              nativeRetirementIds: retirementIds(retirements),
              error: errorMessage(error)
            };
          }
          if (recovery.status === "blocked") {
            return {
              operation,
              conversationId: session.id,
              mutationId,
              localState: "awaiting-recovery",
              projection: "awaiting-recovery",
              nativeRetirement: retirements.length
                ? "awaiting-recovery"
                : "not-required",
              nativeRetirementIds: retirementIds(retirements),
              error: recovery.blocker
            };
          }
          if (recovery.journal.record.state === "aborted") {
            await harnessService.abortNativeExecutionRetirements(
              retirements,
              targetCommitError?.message
                ?? "Conversation RecordMutation was compensated"
            );
            return {
              operation,
              conversationId: session.id,
              mutationId,
              localState: "aborted",
              projection: "updated",
              nativeRetirement: retirements.length ? "aborted" : "not-required",
              nativeRetirementIds: retirementIds(retirements),
              error: targetCommitError?.message
                ?? "Conversation RecordMutation was compensated"
            };
          }
          if (recovery.journal.record.state !== "committed") {
            return {
              operation,
              conversationId: session.id,
              mutationId,
              localState: "awaiting-recovery",
              projection: "awaiting-recovery",
              nativeRetirement: retirements.length
                ? "awaiting-recovery"
                : "not-required",
              nativeRetirementIds: retirementIds(retirements),
              error: targetCommitError?.message
            };
          }

          let nativeRetirement: ConversationRecordMutationReceipt[
            "nativeRetirement"
          ] = retirements.length ? "promoted" : "not-required";
          try {
            await harnessService.promoteNativeExecutionRetirements(
              retirements,
              async (recordMutationId) =>
                await settingsStore.readRecordMutationAuthority(
                  recordMutationId
                )
            );
          } catch {
            if (retirements.length) nativeRetirement = "awaiting-recovery";
          }
          const projection =
            await settingsStore.projectCommittedConversationRecordMutation({
              operation,
              sourceContentRevision: expectedContentRevision,
              sourceSession: session,
              ...(target.session ? { targetSession: target.session } : {})
            }, authority);
          if (nativeRetirement === "promoted") {
            for (const retirement of retirements) {
              void harnessService.cleanupNativeExecutionRecord(
                retirement.retirementId
              ).catch((error) => {
                console.error(
                  `EchoInk native retirement cleanup failed: ${retirement.retirementId}`,
                  error
                );
              });
            }
          }
          return {
            operation,
            conversationId: session.id,
            mutationId,
            localState: "committed",
            projection,
            nativeRetirement,
            nativeRetirementIds: retirementIds(retirements)
          };
        }
      );
    }
  );
}

function createConversationTarget(input: {
  operation: ConversationRecordMutationOperation;
  sourceSession: StoredSession;
  mutationId: string;
  now: number;
}): {
  intentTarget:
    | {
        status: "present";
        generation: number;
        commitId: string;
        contentRevision: string;
      }
    | {
        status: "deleted";
        tombstoneId: string;
        digest: string;
      };
  session?: StoredSession;
  tombstone?: ConversationDeletionTombstoneV1;
} {
  if (input.operation === "delete-conversation") {
    const tombstone = createConversationDeletionTombstone({
      conversationId: input.sourceSession.id,
      mutationId: input.mutationId,
      tombstoneId: `conversation-deletion-${randomUUID()}`,
      sourceGeneration: sessionGeneration(input.sourceSession),
      sourceCommitId: input.sourceSession.commitId!,
      sourceContentRevision:
        createConversationContentRevision(input.sourceSession),
      deletedAt: input.now
    });
    return {
      intentTarget: {
        status: "deleted",
        tombstoneId: tombstone.tombstoneId,
        digest: tombstone.digest
      },
      tombstone
    };
  }
  const sourceGeneration = sessionGeneration(input.sourceSession);
  if (sourceGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "Conversation generation cannot advance beyond MAX_SAFE_INTEGER"
    );
  }
  const session = cloneSession(input.sourceSession);
  session.messages = [];
  session.revision = sourceGeneration + 1;
  session.generation = sourceGeneration + 1;
  session.contextId = `context-${randomUUID()}`;
  session.commitId = `context-commit-${randomUUID()}`;
  delete session.contextStartsAfterMessageId;
  delete session.backendBindings;
  delete session.threadId;
  delete session.contextSnapshot;
  delete session.rollingSummary;
  delete session.messagesHiddenBefore;
  delete session.historyActiveDate;
  delete session.tokenUsage;
  session.updatedAt = Math.max(session.updatedAt, input.now);
  return {
    intentTarget: {
      status: "present",
      generation: session.generation,
      commitId: session.commitId,
      contentRevision: createConversationContentRevision(session)
    },
    session
  };
}

function createNativeRetirements(input: {
  operation: ConversationRecordMutationOperation;
  sourceSession: StoredSession;
  target: ReturnType<typeof createConversationTarget>;
  mutationId: string;
}): SessionNativeRetirement[] {
  if (input.operation === "delete-conversation") {
    return createSessionDeletionRetirements({
      session: input.sourceSession,
      recordMutationId: input.mutationId,
      targetTombstoneId: input.target.tombstone!.tombstoneId,
      targetTombstoneDigest: input.target.tombstone!.digest
    });
  }
  return createSessionRecordClearRetirements({
    sourceSession: input.sourceSession,
    targetSession: input.target.session!,
    recordMutationId: input.mutationId
  });
}

function assertStableReadyInventory(
  first: ConversationRecordInventory,
  second: ConversationRecordInventory
): void {
  if (
    first.snapshotDigest !== second.snapshotDigest
    || first.status !== "ready"
    || second.status !== "ready"
    || first.blockers.length
    || second.blockers.length
  ) {
    const blockers = [...first.blockers, ...second.blockers]
      .map((blocker) => `${blocker.code}:${blocker.subjectId}`)
      .join(",");
    throw new ConversationRecordMutationLifecycleError(
      "inventory_blocked",
      blockers
        ? `Conversation record inventory is blocked: ${blockers}`
        : "Conversation record inventory changed during planning"
    );
  }
}

function assertAuthoritativeLiveSession(
  plugin: ConversationRecordMutationPluginHost,
  session: StoredSession
): void {
  const live = plugin.settings.sessions.find(
    (candidate) => candidate.id === session.id
  );
  if (!live || live !== session) {
    throw new ConversationRecordMutationLifecycleError(
      "conversation_changed",
      `Conversation ${session.id} is not the authoritative live session`
    );
  }
}

function cloneSession(session: StoredSession): StoredSession {
  return structuredClone(session);
}

function cloneSessions(sessions: readonly StoredSession[]): StoredSession[] {
  return structuredClone(sessions) as StoredSession[];
}

function retirementIds(
  retirements: readonly SessionNativeRetirement[]
): string[] {
  return retirements.map((retirement) => retirement.retirementId);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
