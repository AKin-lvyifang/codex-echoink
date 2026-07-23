import { createHash, randomUUID } from "node:crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { swallowError } from "../core/error-handling";
import {
  recoverStaleChatHarnessRuns,
  recoverStaleHarnessRuns
} from "../core/message-state";
import { externalizeLargeMessages, pluginDataDir, prepareRawMessage, readRawText, writeRawText } from "../core/raw-message-store";
import {
  createConversationContentRevision,
  type CommitConversationContextOptions,
  type CommitConversationDeletionTombstoneOptions,
  type CommitConversationRecordClearOptions,
  type ConversationAuthorityProbe,
  type ConversationAuthorityProof,
  type ConversationContextCommitReceipt,
  type ConversationDeletionTombstoneV1,
  type ConversationMessageAuthorityProbe,
  type ConversationMessageAuthorityProof,
  type ConversationRecordMutationSource,
  type PlanConversationRecordMutationSourcesInput
} from "../harness/conversation/conversation-store";
import {
  FileConversationStoreRouter
} from "./conversation-store-router";
import {
  assertConversationMutationAuthority,
  ConversationMutationLane,
  type ConversationMutationAuthority
} from "../harness/conversation/conversation-mutation-lane";
import type {
  SessionContextRecordMutationReceipt,
  SessionContextRecordMutationStageInput
} from "../harness/conversation/context-rotation";
import type {
  RecordMutationConversationObservation
} from "../harness/lifecycle/record-mutation-recovery";
import {
  createRecordMutationJournal,
  listRecordMutationJournals,
  loadRecordMutationJournal,
  stageRecordMutationJournal
} from "../harness/lifecycle/record-mutation-journal";
import {
  withRecordMutationGlobalAuthority
} from "../harness/lifecycle/record-mutation-coordinator";
import {
  runRecordMutationRecovery,
  runRecordMutationRecoveryUnderAuthority,
  type RecordMutationRecoveryRunnerResult,
  type RecordMutationRecoveryTrashParticipant
} from "../harness/lifecycle/record-mutation-recovery-runner";
import type {
  RecordMutationSourceParticipantAdapter
} from "../harness/lifecycle/record-mutation-source-participant";
import {
  loadRecordMutationExecutionPlan
} from "../harness/lifecycle/record-mutation-execution-plan";
import {
  materializeRecordMutationExecution,
  type MaterializedRecordMutationExecution
} from "../harness/lifecycle/record-mutation-execution-runtime";
import {
  createEchoInkRecordMutationSourceAdapterFactory,
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  prepareEchoInkRecordMutationRuntimeRoots,
  type EchoInkRecordMutationRootId
} from "../harness/lifecycle/record-mutation-production";
import {
  FileRunRecordStore
} from "../harness/ledger/run-record-store";
import {
  withMemoryFormalMutation
} from "../harness/memory/v2-store";
import {
  inventoryRawGcPreview,
  type RawGcPreview
} from "../harness/records/conversation-record-inventory";
import {
  RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY,
  authorizeAndPurgeRawGcQuarantine,
  beginRawGcQuarantine,
  recoverStartedRawGcQuarantines,
  type RawGcPurgeResult,
  type RawGcQuarantineResult,
  type RawGcQuarantineRoots,
  type RawGcStableOwnerAuthority
} from "../harness/records/raw-gc-quarantine";
import {
  createEchoInkRecordMutationSelectionVerifier
} from "../harness/records/conversation-record-mutation-selection-verifier";
import type {
  RecordMutationIntent,
  RecordMutationRevision
} from "../harness/lifecycle/record-mutation-contract";
import { sessionGeneration, workspaceFingerprint } from "../harness/kernel/session-service";
import {
  clearLegacyChatWorkspaceDefaults,
  ensureKnowledgeBaseNativeLifecycleRecoveryProjection,
  ensureKnowledgeBaseSession,
  normalizeSettingsData,
  type ChatMessage,
  type CodexForObsidianSettings,
  type KnowledgeBaseSettings,
  type StoredSession
} from "../settings/settings";
import { DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../knowledge-base/constants";
import {
  activeKnowledgeBaseHistoryDate,
  collectKnowledgeBaseStorageStats,
  compactOldKnowledgeBaseProcessHistory,
  exportKnowledgeBaseHistory,
  migrateKnowledgeBaseHistory,
  persistAndCompactKnowledgeBaseHistory,
  pruneKnowledgeBaseHistoryByRetention,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  rebuildKnowledgeBaseHistoryIndex,
  removeKnowledgeBaseHistory,
  removeKnowledgeBaseHistoryDays,
  type KnowledgeBaseHistoryIndex,
  type KnowledgeBaseHistoryRemovalResult,
  type KnowledgeBaseStorageStats
} from "../knowledge-base/history-store";
import { readKnowledgeBaseReportExcerpt, recoveredLintReportSummary, shouldRecoverKnowledgeBaseLintFailure } from "../knowledge-base/report";
import type { LocalRunCommitResult } from "../harness/contracts/native-execution";
import {
  MaintenanceWorkflowWalError,
  type MaintenanceWorkflowSettingsHost,
  type MaintenanceWorkflowSettingsReadback,
  type MaintenanceWorkflowSettingsTransaction
} from "../harness/maintenance/workflow-wal";

export interface SettingsSaveOptions {
  flushConversationStore?: boolean;
  strictConversationStore?: boolean;
  flushKnowledgeBaseHistory?: boolean;
  strictKnowledgeBaseHistory?: boolean;
  flushRawWrites?: boolean;
}

export interface InterruptedRunRecoveryOptions {
  deferKnowledgeMaintenanceRuns?: boolean;
  liveChatRunIds?: readonly string[];
}

interface RuntimePristineConversationCreate {
  session: StoredSession;
  snapshot: StoredSession;
  pending: Promise<void> | null;
  created: boolean;
}

const SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS = 3;

export class EchoInkSettingsStore implements MaintenanceWorkflowSettingsHost<KnowledgeBaseSettings> {
  private startupMaintenancePromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private rawWrites = new Set<Promise<void>>();
  private rawOwnerMutationTail: Promise<void> = Promise.resolve();
  private conversationStore: FileConversationStoreRouter | null = null;
  private conversationStoreRootPath = "";
  private interruptedRunRecoveryQueue: Promise<number> = Promise.resolve(0);
  private settingsCasRecoveryError: MaintenanceWorkflowWalError | null = null;
  private legacyConversationWritesDeferred = false;
  private readonly conversationMutationLane = new ConversationMutationLane();
  private readonly runtimePristineConversationCreates = new Map<
    string,
    RuntimePristineConversationCreate
  >();

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async loadSettings(): Promise<void> {
    const loadedData: unknown = await this.plugin.loadData();
    const data = loadedData ?? {};
    const dataRecord = typeof data === "object" && data !== null
      ? data as Record<string, unknown>
      : {};
    const previousVersion = typeof dataRecord.settingsVersion === "number"
      ? dataRecord.settingsVersion
      : 0;
    const normalized = normalizeSettingsData(data);
    this.plugin.settings = normalized.settings;
    const recoveredConversationShells =
      await this.reconcileAndHydrateConversationSessions();
    const sessionCountBefore = this.plugin.settings.sessions.length;
    const knowledgeSessionBefore = this.plugin.settings.knowledgeBase.sessionId;
    const knowledgeRulesMigrated = await this.applyKnowledgeBaseRulesFileDefault(data);
    const knowledgeSession = ensureKnowledgeBaseSession(
      this.plugin.settings,
      this.plugin.getVaultPath()
    );
    if (this.plugin.settings.sessions.length > sessionCountBefore) {
      this.registerPristineConversationSession(knowledgeSession);
    }
    this.legacyConversationWritesDeferred =
      await this.shouldDeferLegacyConversationWritesUntilV2Migration();
    this.settingsCasRecoveryError = null;
    const interruptedRunsRecovered = this.legacyConversationWritesDeferred
      ? 0
      : await this.recoverInterruptedHarnessRuns(
        undefined,
        { deferKnowledgeMaintenanceRuns: true }
      );
    const legacyChatWorkspacesCleared = clearLegacyChatWorkspaceDefaults(this.plugin.settings, this.plugin.getVaultPath(), previousVersion);
    const knowledgeStatusRecovered = await this.recoverKnowledgeBaseLintStatus();
    const knowledgeSessionChanged = sessionCountBefore !== this.plugin.settings.sessions.length || knowledgeSessionBefore !== this.plugin.settings.knowledgeBase.sessionId;
    if (normalized.changed || recoveredConversationShells > 0 || legacyChatWorkspacesCleared > 0 || knowledgeSessionChanged || knowledgeStatusRecovered || knowledgeRulesMigrated || interruptedRunsRecovered > 0) {
      if (this.legacyConversationWritesDeferred && knowledgeSessionChanged) {
        await this.ensureRuntimePristineConversationSessionsCreated();
      }
      await this.saveSettings(true, {
        flushConversationStore: !this.legacyConversationWritesDeferred,
        flushKnowledgeBaseHistory: false
      });
    }
  }

  isConversationStoreV2MigrationRequired(): boolean {
    return this.legacyConversationWritesDeferred;
  }

  async markConversationStoreV2MigrationComplete(): Promise<void> {
    await this.reconcileAndHydrateConversationSessions();
    this.legacyConversationWritesDeferred = false;
  }

  async recoverInterruptedHarnessRuns(
    sessionId?: string,
    options: InterruptedRunRecoveryOptions = {}
  ): Promise<number> {
    const recovery = this.interruptedRunRecoveryQueue
      .catch(() => 0)
      .then(async () => {
        let recovered = 0;
        const sessions = sessionId
          ? this.plugin.settings.sessions.filter((session) => session.id === sessionId)
          : this.plugin.settings.sessions;
        const liveChatRunIds = new Set(options.liveChatRunIds ?? []);
        for (const session of sessions) {
          try {
            const deferRunIds = options.deferKnowledgeMaintenanceRuns
              ? knowledgeMaintenanceRunIdsPendingWorkflowRecovery(session.messages)
              : undefined;
            const commitLocalHistory = async () => {
              session.updatedAt = Date.now();
              await this.saveSettings(true, {
                strictConversationStore: true,
                strictKnowledgeBaseHistory: session.kind === "knowledge-base"
              });
            };
            const result = session.kind === "knowledge-base"
              ? await recoverStaleHarnessRuns({
                messages: session.messages,
                ...(deferRunIds?.size ? { deferRunIds } : {}),
                commitLocalHistory,
                settleRunTerminal: async (terminal) => {
                  await this.plugin.settleHarnessRunTerminal(terminal);
                }
              })
              : await recoverStaleChatHarnessRuns({
                messages: session.messages,
                ...(deferRunIds?.size ? { deferRunIds } : {}),
                commitLocalHistory,
                commitRunTerminal: async (terminal, persistWinner) => {
                  await this.plugin.commitChatSurfaceTerminal(terminal, {
                    mode: liveChatRunIds.has(terminal.runId)
                      ? "recovery-live"
                      : "recovery-restart",
                    persistConversation: persistWinner
                  });
                }
              });
            recovered += result.settledRunIds.length;
            if (result.failedRunIds.length) {
              console.error("EchoInk interrupted run terminal recovery failed", result.failedRunIds);
            }
          } catch (error) {
            console.error("EchoInk interrupted run local commit failed", error);
          }
        }
        return recovered;
      });
    this.interruptedRunRecoveryQueue = recovery;
    return await recovery;
  }

  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> {
    if (force) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.flushSettingsSave(options);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSettingsSave().catch(swallowError("scheduled settings save failed"));
    }, 750);
  }

  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> {
    let tracked: Promise<void>;
    let attemptedRawRef: string | null = null;
    tracked = this.withRawOwnerMutation(async () => {
      const write = prepareRawMessage(message, fullText);
      if (!write) return;
      attemptedRawRef = write.rawRef;
      await withRecordMutationGlobalAuthority(
        this.recordMutationStorageRootPath(),
        `raw-write-${randomUUID()}`,
        async () => await writeRawText(
          this.plugin.getVaultPath(),
          write.rawRef,
          write.text,
          this.plugin.getPluginDataDirName()
        )
      );
    })
      .catch((error) => {
        console.error("Codex raw message write failed", error);
        // The lane owns both the in-memory rawRef mutation and its file write,
        // so a failed write can safely restore the full inline message.
        if (attemptedRawRef && message.rawRef === attemptedRawRef) {
          message.text = fullText;
          delete message.previewText;
          delete message.rawRef;
          delete message.rawSize;
          delete message.rawLines;
          delete message.rawTruncatedForPreview;
        }
      })
      .finally(() => this.rawWrites.delete(tracked));
    this.rawWrites.add(tracked);
    await tracked;
  }

  async previewRawGcQuarantine(): Promise<RawGcPreview> {
    return await inventoryRawGcPreview({
      vaultPath: this.plugin.getVaultPath(),
      pluginDir: this.plugin.getPluginDataDirName()
    });
  }

  async beginRawGcQuarantine(input: {
    transactionId: string;
    expectedPreviewDigest: string;
    selectedSubjectRefs: readonly string[];
    confirmedAt: number;
  }): Promise<RawGcQuarantineResult> {
    const roots = await this.prepareRawGcQuarantineRoots(input.confirmedAt);
    return await beginRawGcQuarantine({
      vaultPath: this.plugin.getVaultPath(),
      pluginDir: this.plugin.getPluginDataDirName(),
      ...input,
      roots,
      ownerAuthority: this.rawGcOwnerAuthority()
    });
  }

  async authorizeAndPurgeRawGcQuarantine(
    transactionId: string
  ): Promise<RawGcPurgeResult> {
    const roots = await this.prepareRawGcQuarantineRoots(Date.now());
    return await authorizeAndPurgeRawGcQuarantine({
      vaultPath: this.plugin.getVaultPath(),
      pluginDir: this.plugin.getPluginDataDirName(),
      transactionId,
      roots,
      ownerAuthority: this.rawGcOwnerAuthority()
    });
  }

  async recoverStartedRawGcQuarantines(): Promise<number> {
    const namespacePath = path.join(
      this.recordMutationStorageRootPath(),
      RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY
    );
    const namespace = await fsp.lstat(namespacePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    );
    if (!namespace) return 0;
    if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
      throw new Error("Raw GC quarantine journal root is unsafe");
    }
    const roots = await this.prepareRawGcQuarantineRoots(Date.now());
    return await recoverStartedRawGcQuarantines({
      vaultPath: this.plugin.getVaultPath(),
      pluginDir: this.plugin.getPluginDataDirName(),
      roots,
      ownerAuthority: this.rawGcOwnerAuthority()
    });
  }

  private rawGcOwnerAuthority(): RawGcStableOwnerAuthority {
    return {
      withStableOwners: async <T>(
        action: () => Promise<T>
      ): Promise<T> => await this.withRawGcStableOwners(action)
    };
  }

  private async withRawGcStableOwners<T>(
    action: () => Promise<T>
  ): Promise<T> {
    const run = this.saveQueue.then(async () => {
      this.assertNoSettingsCasRecoveryConflict();
      await this.flushRawWrites();
      return await this.withRawOwnerMutation(async () => {
        // Persist every Raw ref that completed before this authority. The raw
        // owner lane blocks new externalization, saveQueue blocks projection
        // flushes, the global authority freezes Conversation/Artifact/WAL
        // writers, and the Run Store mutation lane freezes payload owners.
        ensureKnowledgeBaseNativeLifecycleRecoveryProjection(
          this.plugin.settings.knowledgeBase
        );
        const prepared = await this.prepareCanonicalSettingsCandidate();
        const candidate = await this.persistCanonicalConversationAndHistory(
          prepared.candidate,
          prepared.liveBefore,
          {
            flushConversationStore: true,
            strictConversationStore: true,
            flushKnowledgeBaseHistory: true,
            strictKnowledgeBaseHistory: false
          }
        );
        await this.persistSettingsDataCandidate(
          candidate,
          prepared.persistedBefore
        );
        const storageRootPath = this.recordMutationStorageRootPath();
        return await withRecordMutationGlobalAuthority(
          storageRootPath,
          `raw-gc-owner-${randomUUID()}`,
          async () => await new FileRunRecordStore({
            storageRootPath
          }).withMutation(action)
        );
      });
    });
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  private async prepareRawGcQuarantineRoots(
    createdAt: number
  ): Promise<RawGcQuarantineRoots> {
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath: this.plugin.getVaultPath(),
      pluginDir: this.plugin.getPluginDataDirName(),
      rootIds: [
        ECHOINK_RECORD_MUTATION_ROOT_IDS.raw,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      ],
      createdAt
    });
    const source = prepared.roots.find((root) =>
      root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.raw
    );
    const trash = prepared.roots.find((root) =>
      root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    );
    if (!source || !trash) {
      throw new Error("Raw GC quarantine roots are incomplete");
    }
    return {
      storageRootPath: prepared.storageRootPath,
      sourceRootPath: source.rootPath,
      sourceBoundaryRootPath: source.boundaryRootPath,
      sourceRootBinding: source.rootBinding,
      trashRootPath: trash.rootPath,
      trashBoundaryRootPath: trash.boundaryRootPath,
      trashRootBinding: trash.rootBinding
    };
  }

  private async withRawOwnerMutation<T>(
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.rawOwnerMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rawOwnerMutationTail = previous.then(() => current);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async readRawMessageText(rawRef: string): Promise<string> {
    return readRawText(this.plugin.getVaultPath(), rawRef, this.plugin.getPluginDataDirName());
  }

  async readConversationSession(sessionId: string): Promise<StoredSession | null> {
    return await this.getConversationStore().readSession(sessionId);
  }

  async resolveConversationStoreRootPath(): Promise<string> {
    return await this.getConversationStore().resolveLiveRootPath();
  }

  async resolveConversationRecordMutationRoute() {
    return await this.getConversationStore().resolveRecordMutationRoute();
  }

  async proveConversationMessageAuthority(
    probe: ConversationMessageAuthorityProbe
  ): Promise<ConversationMessageAuthorityProof> {
    return await this.getConversationStore().proveMessageAuthority(probe);
  }

  async withSettingsPersistenceAuthorityGate<R>(
    action: () => Promise<R>
  ): Promise<R> {
    const run = this.saveQueue.then(action);
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async withMigrationPersistenceQuietWindow<R>(
    quietWindowIdInput: string,
    action: () => Promise<R>
  ): Promise<R> {
    const quietWindowId = quietWindowIdInput.trim();
    if (!quietWindowId) {
      throw new Error("Migration persistence quiet window requires an id");
    }
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const authorityId = `migration-quiet-${
      createHash("sha256")
        .update(quietWindowId)
        .digest("hex")
        .slice(0, 32)
    }`;
    const run = this.saveQueue.then(async () => {
      this.assertNoSettingsCasRecoveryConflict();
      await this.flushRawWrites();
      return await this.withRawOwnerMutation(async () => {
        ensureKnowledgeBaseNativeLifecycleRecoveryProjection(
          this.plugin.settings.knowledgeBase
        );
        const prepared = await this.prepareCanonicalSettingsCandidate();
        await this.persistSettingsDataCandidate(
          prepared.candidate,
          prepared.persistedBefore
        );
        const storageRootPath = this.recordMutationStorageRootPath();
        return await withRecordMutationGlobalAuthority(
          storageRootPath,
          authorityId,
          async () => await withMemoryFormalMutation(
            this.plugin.getVaultPath(),
            async () => await new FileRunRecordStore({
              storageRootPath
            }).withMutation(action)
          )
        );
      });
    });
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async withConversationMutation<R>(
    conversationId: string,
    action: (authority: ConversationMutationAuthority) => Promise<R>
  ): Promise<R> {
    return await this.conversationMutationLane.withConversationMutation(
      conversationId,
      async (authority) => await withRecordMutationGlobalAuthority(
        this.recordMutationStorageRootPath(),
        `conversation-write-${randomUUID()}`,
        async () => await action(authority)
      )
    );
  }

  async stageSessionContextRecordMutation(
    input: SessionContextRecordMutationStageInput
  ): Promise<SessionContextRecordMutationReceipt> {
    const operation = input.reason === "start-new-context"
      ? "start-new-context" as const
      : input.reason === "history-restore"
        ? "start-new-context" as const
      : input.reason === "agent-cache-reset"
        ? "reset-agent-cache" as const
        : null;
    if (!operation) {
      throw new Error(
        `Context rotation reason does not use a live RecordMutation Journal: ${input.reason}`
      );
    }
    const createdAt = Date.now();
    const planned = await createRecordMutationJournal({
      storageRootPath: this.recordMutationStorageRootPath(),
      mutationId: `context-mutation-${randomUUID()}`,
      intent: {
        operation,
        conversationId: input.session.id,
        expectedConversationGeneration: input.expectedGeneration,
        expectedConversationCommitId: input.expectedCommitId ?? null,
        expectedConversationContentRevision: input.expectedContentRevision,
        targetConversation: {
          status: "present",
          generation: input.targetGeneration,
          commitId: input.targetCommitId,
          contentRevision: createConversationContentRevision(input.session)
        },
        participants: [
          { id: "artifact", recordKind: "artifact", action: "retain" },
          { id: "conversation", recordKind: "conversation", action: "retain" },
          { id: "memory", recordKind: "memory", action: "retain" },
          { id: "raw", recordKind: "raw", action: "retain" },
          { id: "workflow-run", recordKind: "workflow-run", action: "retain" }
        ],
        rootBindings: [],
        trashPolicy: "not-required"
      },
      createdAt
    });
    const staged = await stageRecordMutationJournal(planned.handle, {
      expectedRevision: planned.record.revision,
      expectedDigest: planned.record.digest,
      step: {
        direction: "forward",
        ordinal: 1,
        participantId: "conversation",
        action: "prepared",
        evidenceDigest: planned.record.intentDigest
      },
      updatedAt: createdAt + 1
    });
    return { mutationId: staged.record.mutationId };
  }

  async settleSessionContextRecordMutation(
    receipt: SessionContextRecordMutationReceipt,
    authority: ConversationMutationAuthority
  ): Promise<"committed" | "aborted"> {
    const journal = await loadRecordMutationJournal({
      storageRootPath: this.recordMutationStorageRootPath(),
      mutationId: receipt.mutationId
    });
    assertConversationMutationAuthority(
      authority,
      journal.record.intent.conversationId
    );
    const result = await runRecordMutationRecoveryUnderAuthority({
      journal,
      withConversationMutation: async (conversationId, action) =>
        await this.withConversationMutation(conversationId, action),
      inspectConversation: async (intent) =>
        await this.inspectRecordMutationConversation(intent),
      trashParticipants: [],
      sourceDeletedParticipants: []
    }, authority);
    if (result.status === "blocked") {
      throw new Error(
        `RecordMutation Journal ${receipt.mutationId} is blocked: ${result.blocker}`
      );
    }
    const state = result.journal.record.state;
    if (state !== "committed" && state !== "aborted") {
      throw new Error(
        `RecordMutation Journal ${receipt.mutationId} has no terminal state`
      );
    }
    return state;
  }

  async reconcileSessionContextRecordMutationsAtStartup(): Promise<number> {
    const journals = await listRecordMutationJournals(
      this.recordMutationStorageRootPath()
    );
    let recovered = 0;
    for (const journal of journals) {
      if (
        journal.record.state === "committed"
        || journal.record.state === "aborted"
      ) {
        continue;
      }
      if (journal.record.intent.trashPolicy === "required") {
        const result = await this.withConversationMutation(
          journal.record.intent.conversationId,
          async (authority) => {
            const executionPlan = await loadRecordMutationExecutionPlan({
              storageRootPath: this.recordMutationStorageRootPath(),
              mutationId: journal.record.mutationId,
              journal
            });
            if (!executionPlan) {
              throw new Error(
                `Destructive RecordMutation execution plan is missing: ${journal.record.mutationId}`
              );
            }
            const preparedRoots =
              await prepareEchoInkRecordMutationRuntimeRoots({
                vaultPath: this.plugin.getVaultPath(),
                pluginDir: this.plugin.getPluginDataDirName(),
                rootIds: journal.record.intent.rootBindings.map(
                  (binding) => binding.rootId as EchoInkRecordMutationRootId
                ),
                createdAt: journal.record.createdAt,
                conversationRootPath:
                  await this.resolveConversationStoreRootPath()
              });
            const materialized = await materializeRecordMutationExecution({
              plan: executionPlan,
              journal,
              roots: preparedRoots.roots,
              createSourceAdapter:
                createEchoInkRecordMutationSourceAdapterFactory({
                  vaultPath: this.plugin.getVaultPath()
                }),
              verifyFrozenSelection:
                createEchoInkRecordMutationSelectionVerifier({
                  vaultPath: this.plugin.getVaultPath(),
                  pluginDir: this.plugin.getPluginDataDirName(),
                  getConversations: () => this.plugin.settings.sessions
                })
            });
            return await runRecordMutationRecoveryUnderAuthority({
              journal: materialized.journal,
              withConversationMutation: async (conversationId, action) =>
                await this.withConversationMutation(conversationId, action),
              inspectConversation: async (intent) =>
                await this.inspectRecordMutationConversation(intent),
              trashParticipants: materialized.trashParticipants,
              sourceDeletedParticipants:
                materialized.sourceDeletedParticipants
            }, authority);
          }
        );
        if (result.status === "blocked") {
          throw new Error(
            `RecordMutation startup recovery blocked for ${journal.record.mutationId}: ${result.blocker}`
          );
        }
        recovered += 1;
        continue;
      }
      let recoverableJournal = journal;
      const trashParticipants: RecordMutationRecoveryTrashParticipant[] = [];
      const sourceDeletedParticipants:
        RecordMutationSourceParticipantAdapter[] = [];
      if (recoverableJournal.record.state === "planned") {
        const participant = recoverableJournal.record.intent.participants.find(
          (candidate) =>
            candidate.recordKind === "conversation"
            && candidate.action === "retain"
        );
        if (!participant) {
          throw new Error(
            `Planned RecordMutation Journal has no retained Conversation participant: ${journal.record.mutationId}`
          );
        }
        recoverableJournal = await stageRecordMutationJournal(
          recoverableJournal.handle,
          {
            expectedRevision: recoverableJournal.record.revision,
            expectedDigest: recoverableJournal.record.digest,
            step: {
              direction: "forward",
              ordinal: 1,
              participantId: participant.id,
              action: "prepared",
              evidenceDigest: recoverableJournal.record.intentDigest
            },
            updatedAt: Math.max(
              Date.now(),
              recoverableJournal.record.updatedAt + 1
            )
          }
        );
      }
      const result = await runRecordMutationRecovery({
        journal: recoverableJournal,
        withConversationMutation: async (conversationId, action) =>
          await this.withConversationMutation(conversationId, action),
        inspectConversation: async (intent) =>
          await this.inspectRecordMutationConversation(intent),
        trashParticipants,
        sourceDeletedParticipants
      });
      if (result.status === "blocked") {
        throw new Error(
          `RecordMutation startup recovery blocked for ${recoverableJournal.record.mutationId}: ${result.blocker}`
        );
      }
      recovered += 1;
    }
    return recovered;
  }

  async readRecordMutationAuthority(
    mutationId: string
  ): Promise<RecordMutationRevision> {
    const journal = await loadRecordMutationJournal({
      storageRootPath: this.recordMutationStorageRootPath(),
      mutationId
    });
    return structuredClone(journal.record);
  }

  poisonSettingsPersistenceForRecovery(message: string): void {
    this.poisonSettingsRecovery("settings_persist_failed", message);
  }

  registerPristineConversationSession(session: StoredSession): void {
    this.assertAuthoritativeLiveSession(session);
    assertRuntimePristineConversation(session);
    const existing = this.runtimePristineConversationCreates.get(session.id);
    if (existing) {
      if (existing.session !== session) {
        throw new Error(
          `Conversation recovery required: runtime pristine identity conflict for ${session.id}`
        );
      }
      return;
    }
    const entry: RuntimePristineConversationCreate = {
      session,
      snapshot: cloneStoredSession(session),
      pending: null,
      created: false
    };
    this.runtimePristineConversationCreates.set(session.id, entry);
    void this.startPristineConversationCreate(entry).catch(() => undefined);
  }

  async ensureConversationSessionCreated(session: StoredSession): Promise<void> {
    this.assertAuthoritativeLiveSession(session);
    const entry = this.runtimePristineConversationCreates.get(session.id);
    if (entry) {
      if (entry.session !== session) {
        throw new Error(
          `Conversation recovery required: runtime pristine identity conflict for ${session.id}`
        );
      }
      await this.startPristineConversationCreate(entry);
    }
    const stored = await this.getConversationStore().readSession(session.id);
    if (!stored) {
      throw new Error(
        `Conversation recovery required: conversation ${session.id} is missing`
      );
    }
    assertConversationContextIdentityMatches(stored, session);
    if (entry?.created) this.runtimePristineConversationCreates.delete(session.id);
  }

  async commitConversationSessionContext(
    session: StoredSession,
    options: CommitConversationContextOptions & {
      historyRestoreMutationId?: string;
    }
  ): Promise<ConversationContextCommitReceipt> {
    const authoritative = this.plugin.settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    if (!authoritative) {
      throw new Error(
        `Conversation recovery required: conversation ${session.id} is not live`
      );
    }
    await this.ensureConversationSessionCreated(authoritative);
    if (options.historyRestoreMutationId) {
      return await this.getConversationStore().commitConversationHistoryRestore(
        session,
        {
          mutationId: options.historyRestoreMutationId,
          expectedGeneration: options.expectedGeneration,
          expectedCommitId: options.expectedCommitId,
          expectedContentRevision: options.expectedContentRevision
        }
      );
    }
    return await this.getConversationStore().commitSessionContext(session, options);
  }

  async proveConversationSessionContextAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof> {
    return await this.getConversationStore().proveSessionContextAuthority(probe);
  }

  async planConversationRecordMutationSources(
    input: PlanConversationRecordMutationSourcesInput,
    authority: ConversationMutationAuthority
  ): Promise<ConversationRecordMutationSource[]> {
    assertConversationMutationAuthority(authority, input.conversationId);
    return await this.getConversationStore()
      .planConversationRecordMutationSources(input);
  }

  async commitConversationRecordClear(
    session: StoredSession,
    options: CommitConversationRecordClearOptions,
    authority: ConversationMutationAuthority
  ): Promise<ConversationContextCommitReceipt> {
    assertConversationMutationAuthority(authority, session.id);
    return await this.getConversationStore()
      .commitConversationRecordClear(session, options);
  }

  async commitConversationDeletionTombstone(
    tombstone: ConversationDeletionTombstoneV1,
    options: CommitConversationDeletionTombstoneOptions,
    authority: ConversationMutationAuthority
  ): Promise<ConversationDeletionTombstoneV1> {
    assertConversationMutationAuthority(
      authority,
      tombstone.conversationId
    );
    return await this.getConversationStore()
      .commitConversationDeletionTombstone(tombstone, options);
  }

  async settleConversationRecordMutationExecution(
    execution: MaterializedRecordMutationExecution,
    authority: ConversationMutationAuthority
  ): Promise<RecordMutationRecoveryRunnerResult> {
    assertConversationMutationAuthority(
      authority,
      execution.journal.record.intent.conversationId
    );
    return await runRecordMutationRecoveryUnderAuthority({
      journal: execution.journal,
      withConversationMutation: async (conversationId, action) =>
        await this.withConversationMutation(conversationId, action),
      inspectConversation: async (intent) =>
        await this.inspectRecordMutationConversation(intent),
      trashParticipants: execution.trashParticipants,
      sourceDeletedParticipants: execution.sourceDeletedParticipants
    }, authority);
  }

  async projectCommittedConversationRecordMutation(input: {
    operation: "clear-conversation-records" | "delete-conversation";
    sourceContentRevision: string;
    sourceSession: StoredSession;
    targetSession?: StoredSession;
  }, authority: ConversationMutationAuthority): Promise<
    "updated" | "awaiting-recovery"
  > {
    assertConversationMutationAuthority(authority, input.sourceSession.id);
    const index = this.plugin.settings.sessions.findIndex(
      (candidate) => candidate.id === input.sourceSession.id
    );
    if (index < 0) {
      return input.operation === "delete-conversation"
        ? "updated"
        : "awaiting-recovery";
    }
    const live = this.plugin.settings.sessions[index];
    if (
      live !== input.sourceSession
      || createConversationContentRevision(live)
        !== input.sourceContentRevision
    ) {
      return "awaiting-recovery";
    }
    if (input.operation === "delete-conversation") {
      this.plugin.settings.sessions.splice(index, 1);
      if (this.plugin.settings.activeSessionId === input.sourceSession.id) {
        this.plugin.settings.activeSessionId =
          this.plugin.settings.sessions[0]?.id ?? "";
      }
    } else {
      if (!input.targetSession) return "awaiting-recovery";
      replaceStoredSessionInPlace(live, input.targetSession);
    }
    try {
      await this.saveSettings(true, {
        flushConversationStore: false,
        flushKnowledgeBaseHistory: false
      });
      return "updated";
    } catch {
      return "awaiting-recovery";
    }
  }

  async commitKnowledgeRunDurably(): Promise<LocalRunCommitResult> {
    try {
      await this.saveSettings(true, { strictConversationStore: true, strictKnowledgeBaseHistory: true });
      return localRunCommitResult(true);
    } catch (error) {
      return localRunCommitResult(false, error instanceof Error ? error.message : String(error));
    }
  }

  async withExclusiveTransaction<R>(
    action: (
      transaction: MaintenanceWorkflowSettingsTransaction<KnowledgeBaseSettings>
    ) => Promise<R>
  ): Promise<R> {
    const run = this.saveQueue.then(async () => {
      this.assertNoSettingsCasRecoveryConflict();
      let transactionBaseline = await this.readPersistedKnowledgeBaseSettings();
      let persistedInTransaction = false;
      return await action({
        readWithGeneration: async () => {
          if (persistedInTransaction) {
            transactionBaseline = await this.readPersistedKnowledgeBaseSettings();
          }
          return cloneKnowledgeBaseSettingsReadback(transactionBaseline);
        },
        persistCas: async (expectedGeneration, settings) => {
          if (expectedGeneration !== transactionBaseline.generation) {
            throw new MaintenanceWorkflowWalError(
              "settings_cas_conflict",
              "knowledge-base settings transaction baseline 已变化"
            );
          }
          const persisted = await this.persistKnowledgeBaseSettingsCas(
            expectedGeneration,
            transactionBaseline.generation,
            settings
          );
          transactionBaseline = cloneKnowledgeBaseSettingsReadback(persisted);
          persistedInTransaction = true;
          return cloneKnowledgeBaseSettingsReadback(persisted);
        }
      });
    });
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async readKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return readKnowledgeBaseHistoryIndex(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async readKnowledgeBaseHistoryDay(sessionId: string, date: string): Promise<ChatMessage[]> {
    return readKnowledgeBaseHistoryDay(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName(), sessionId, date);
  }

  async rebuildKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return await this.withSettingsPersistenceAuthorityGate(async () =>
      await rebuildKnowledgeBaseHistoryIndex(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName(),
        {
          retentionDays:
            this.plugin.settings.knowledgeBase.historyRetentionDays
        }
      )
    );
  }

  async getKnowledgeBaseStorageStats(): Promise<KnowledgeBaseStorageStats> {
    return collectKnowledgeBaseStorageStats(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async exportKnowledgeBaseHistory(): Promise<string> {
    return exportKnowledgeBaseHistory(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName());
  }

  async compactOldKnowledgeBaseProcessHistory(): Promise<number> {
    return await this.withSettingsPersistenceAuthorityGate(async () =>
      await compactOldKnowledgeBaseProcessHistory(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName()
      )
    );
  }

  async removeKnowledgeBaseHistory(): Promise<KnowledgeBaseHistoryRemovalResult> {
    return await this.withSettingsPersistenceAuthorityGate(async () =>
      await removeKnowledgeBaseHistory(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName()
      )
    );
  }

  async removeKnowledgeBaseHistoryDays(dates: string[]): Promise<KnowledgeBaseHistoryRemovalResult> {
    return await this.withSettingsPersistenceAuthorityGate(async () =>
      await removeKnowledgeBaseHistoryDays(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName(),
        dates
      )
    );
  }

  async pruneKnowledgeBaseHistoryByRetention(): Promise<KnowledgeBaseHistoryRemovalResult> {
    return await this.withSettingsPersistenceAuthorityGate(async () =>
      await pruneKnowledgeBaseHistoryByRetention(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName(),
        this.plugin.settings.knowledgeBase.historyRetentionDays
      )
    );
  }

  async runDeferredStartupMaintenance(): Promise<void> {
    if (this.startupMaintenancePromise) return this.startupMaintenancePromise;
    this.startupMaintenancePromise = (async () => {
      let changed = false;
      try {
        changed = await this.withRawOwnerMutation(async () =>
          await withRecordMutationGlobalAuthority(
            this.recordMutationStorageRootPath(),
            `raw-migration-${randomUUID()}`,
            async () => await externalizeLargeMessages(
              this.plugin.getVaultPath(),
              this.plugin.settings,
              this.plugin.getPluginDataDirName()
            )
          )
        ) > 0 || changed;
      } catch (error) {
        console.error("Codex raw message migration failed", error);
      }
      try {
        changed = (
          await this.withSettingsPersistenceAuthorityGate(async () =>
            await migrateKnowledgeBaseHistory(
              this.plugin.getVaultPath(),
              this.plugin.getPluginDataDirName(),
              this.plugin.settings
            )
          )
        ).changed || changed;
      } catch (error) {
        console.error("Codex knowledge history migration failed", error);
      }
      try {
        await this.pruneKnowledgeBaseHistoryByRetention();
      } catch (error) {
        console.warn("Codex knowledge history retention cleanup failed", error);
      }
      if (changed) await this.saveSettings(true, { flushKnowledgeBaseHistory: false });
    })().finally(() => {
      this.startupMaintenancePromise = null;
    });
    return this.startupMaintenancePromise;
  }

  private async applyKnowledgeBaseRulesFileDefault(data: unknown): Promise<boolean> {
    const rawSettings = typeof data === "object" && data !== null ? (data as { knowledgeBase?: unknown }).knowledgeBase : null;
    const hasExplicitRules = typeof rawSettings === "object" && rawSettings !== null
      && (typeof (rawSettings as { useCustomRulesFile?: unknown }).useCustomRulesFile === "boolean" || typeof (rawSettings as { rulesFilePath?: unknown }).rulesFilePath === "string");
    if (hasExplicitRules) return false;

    const vaultPath = this.plugin.getVaultPath();
    const llmWikiPath = path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
    const llmWiki = await fsp.readFile(llmWikiPath, "utf8").catch(() => "");
    if (!llmWiki) return false;
    const llmWikiLooksLikeKnowledgeRules = /知识库|Raw Sources|Ingest|Lint|Wiki/.test(llmWiki);
    if (!llmWikiLooksLikeKnowledgeRules) return false;

    this.plugin.settings.knowledgeBase.useCustomRulesFile = true;
    this.plugin.settings.knowledgeBase.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
    return true;
  }

  private async recoverKnowledgeBaseLintStatus(): Promise<boolean> {
    const settings = this.plugin.settings.knowledgeBase;
    if (settings.lastRunStatus !== "failed" || !settings.lastReportPath) return false;
    const report = await readKnowledgeBaseReportExcerpt(this.plugin.getVaultPath(), settings.lastReportPath, 2000);
    if (!shouldRecoverKnowledgeBaseLintFailure(settings.lastError, report)) return false;
    settings.lastRunStatus = "success";
    settings.lastError = "";
    settings.lastSummary = `${recoveredLintReportSummary(settings.lastReportPath)}\n\n${report}`.slice(0, 1000);
    return true;
  }

  private async flushSettingsSave(options: SettingsSaveOptions = {}): Promise<void> {
    const run = this.saveQueue.then(async () => {
      this.assertNoSettingsCasRecoveryConflict();
      ensureKnowledgeBaseNativeLifecycleRecoveryProjection(
        this.plugin.settings.knowledgeBase
      );
      if (options.flushRawWrites !== false) {
        await this.flushRawWrites();
      }
      const prepared = await this.prepareCanonicalSettingsCandidate();
      const candidate = await this.persistCanonicalConversationAndHistory(
        prepared.candidate,
        prepared.liveBefore,
        {
          flushConversationStore: options.flushConversationStore !== false,
          strictConversationStore: options.strictConversationStore !== false,
          flushKnowledgeBaseHistory: options.flushKnowledgeBaseHistory !== false,
          strictKnowledgeBaseHistory: options.strictKnowledgeBaseHistory === true
        }
      );
      await this.persistSettingsDataCandidate(
        candidate,
        prepared.persistedBefore
      );
    });
    this.saveQueue = run.catch((error) => {
      this.reportSettingsSaveError(error);
    });
    await run;
  }

  private async readPersistedKnowledgeBaseSettings(): Promise<
    MaintenanceWorkflowSettingsReadback<KnowledgeBaseSettings>
  > {
    const persisted = normalizeSettingsData((await this.plugin.loadData()) ?? {}).settings.knowledgeBase;
    const settings = cloneKnowledgeBaseSettings(persisted);
    return {
      settings,
      generation: knowledgeBaseSettingsGeneration(settings)
    };
  }

  private async persistKnowledgeBaseSettingsCas(
    expectedGeneration: string,
    expectedMemoryGeneration: string,
    targetSettings: KnowledgeBaseSettings
  ): Promise<MaintenanceWorkflowSettingsReadback<KnowledgeBaseSettings>> {
    this.assertMemoryKnowledgeBaseGeneration(expectedMemoryGeneration);
    const before = await this.readPersistedKnowledgeBaseSettings();
    if (before.generation !== expectedGeneration) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        "knowledge-base settings generation 已变化，拒绝覆盖并发写入"
      );
    }

    const expectedTarget = cloneKnowledgeBaseSettings(targetSettings);
    let committedCandidate: CodexForObsidianSettings | null = null;
    let committedLiveBefore: CodexForObsidianSettings | null = null;
    let persistedBefore: unknown;
    for (
      let attempt = 1;
      attempt <= SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS;
      attempt += 1
    ) {
      this.assertMemoryKnowledgeBaseGeneration(expectedMemoryGeneration);
      const liveBefore = cloneSettings(this.plugin.settings);
      const candidate = cloneSettings(liveBefore);
      candidate.knowledgeBase = cloneKnowledgeBaseSettings(expectedTarget);
      persistedBefore = await this.readPersistedSettingsDataStrict();
      this.assertMemoryKnowledgeBaseGeneration(expectedMemoryGeneration);
      if (stableJson(this.plugin.settings) !== stableJson(liveBefore)) {
        if (attempt < SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS) continue;
        throw new MaintenanceWorkflowWalError(
          "settings_cas_conflict",
          "knowledge-base settings CAS 在 data shell 提交前持续变化，已耗尽稳定化预算"
        );
      }

      committedCandidate = candidate;
      committedLiveBefore = liveBefore;
      break;
    }
    if (!committedCandidate || !committedLiveBefore) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        "knowledge-base settings CAS 无法取得稳定的 data shell 候选"
      );
    }

    // The workflow WAL is the durable authority for the maintenance result.
    // Its settings CAS must commit only the KnowledgeBase data shell: an
    // unrelated Conversation V2 conflict or a rebuildable History projection
    // cannot block WAL finalization and keep the knowledge input locked.
    // Full Knowledge runs still use commitKnowledgeRunDurably(), which retains
    // the strict Conversation -> History -> data shell ordering.
    await this.persistSettingsDataCandidate(
      committedCandidate,
      persistedBefore
    );

    let readback: MaintenanceWorkflowSettingsReadback<KnowledgeBaseSettings>;
    try {
      readback = await this.readPersistedKnowledgeBaseSettings();
    } catch (readbackError) {
      throw this.poisonSettingsRecovery(
        "settings_persist_failed",
        `knowledge-base settings target 可能已耐久，但 post-commit readback 失败：${errorMessage(readbackError)}`
      );
    }
    if (
      readback.generation !== knowledgeBaseSettingsGeneration(expectedTarget)
      || stableJson(readback.settings) !== stableJson(expectedTarget)
    ) {
      throw this.poisonSettingsRecovery(
        "settings_persist_failed",
        "knowledge-base settings target 可能已耐久，但 post-commit readback 不一致"
      );
    }

    const liveMerge = mergeKnowledgeBaseSettingsAfterCas(
      committedLiveBefore.knowledgeBase,
      readback.settings,
      this.plugin.settings.knowledgeBase
    );
    if (liveMerge.conflicts.length) {
      throw this.poisonSettingsRecovery(
        "settings_cas_conflict",
        `knowledge-base settings target 已耐久，但 live 同字段冲突（${liveMerge.conflicts.join(", ")}）`
      );
    }
    replaceKnowledgeBaseSettingsInPlace(
      this.plugin.settings.knowledgeBase,
      liveMerge.settings
    );
    return {
      settings: cloneKnowledgeBaseSettings(readback.settings),
      generation: readback.generation
    };
  }

  private assertMemoryKnowledgeBaseGeneration(expectedGeneration: string): void {
    if (
      knowledgeBaseSettingsGeneration(this.plugin.settings.knowledgeBase)
      !== expectedGeneration
    ) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        "knowledge-base settings 存在尚未入队的并发内存修改"
      );
    }
  }

  private assertNoSettingsCasRecoveryConflict(): void {
    if (this.settingsCasRecoveryError) {
      throw this.settingsCasRecoveryError;
    }
  }

  private poisonSettingsRecovery(
    code: "settings_cas_conflict" | "settings_persist_failed",
    message: string
  ): MaintenanceWorkflowWalError {
    const error = new MaintenanceWorkflowWalError(
      code,
      `${message}；必须通过 loadSettings 或重启恢复后再保存`
    );
    this.settingsCasRecoveryError = error;
    return error;
  }

  private reportSettingsSaveError(error: unknown): void {
    console.error("[EchoInk] settings save failed:", error);
    new Notice(this.plugin.settings.settingsLanguage === "en" ? "EchoInk settings save failed" : "EchoInk 设置保存失败，请稍后重试");
  }

  private async flushRawWrites(): Promise<void> {
    const pending = Array.from(this.rawWrites);
    if (pending.length) await Promise.allSettled(pending);
  }

  private async prepareCanonicalSettingsCandidate(): Promise<{
    liveBefore: CodexForObsidianSettings;
    candidate: CodexForObsidianSettings;
    persistedBefore: unknown;
  }> {
    for (
      let attempt = 1;
      attempt <= SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS;
      attempt += 1
    ) {
      const liveBefore = cloneSettings(this.plugin.settings);
      const candidate = cloneSettings(liveBefore);
      const persistedBefore = await this.readPersistedSettingsDataStrict();
      if (stableJson(this.plugin.settings) === stableJson(liveBefore)) {
        return { liveBefore, candidate, persistedBefore };
      }
      if (attempt === SETTINGS_CAS_MAX_PRE_COMMIT_ATTEMPTS) {
        throw new MaintenanceWorkflowWalError(
          "settings_cas_conflict",
          "settings 在 Conversation 提交前持续变化，已耗尽稳定化预算"
        );
      }
    }
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      "settings 无法取得稳定的 Conversation 候选"
    );
  }

  private async persistCanonicalConversationAndHistory(
    fullCandidate: CodexForObsidianSettings,
    liveBefore: CodexForObsidianSettings,
    options: {
      flushConversationStore: boolean;
      strictConversationStore: boolean;
      flushKnowledgeBaseHistory: boolean;
      strictKnowledgeBaseHistory: boolean;
    }
  ): Promise<CodexForObsidianSettings> {
    prepareKnowledgeBaseHistoryMetadata(fullCandidate);
    const synchronizeCanonicalSession =
      createAdvancingCanonicalSessionSynchronizer(
        this.plugin.settings,
        fullCandidate,
        liveBefore
      );
    if (!options.flushKnowledgeBaseHistory) {
      if (options.flushConversationStore) {
        await this.flushConversationStore(
          options.strictConversationStore,
          fullCandidate,
          synchronizeCanonicalSession
        );
      }
      return fullCandidate;
    }

    // Conversation is the source authority for every History row. A caller
    // cannot publish History while bypassing this full-message durable pass,
    // even when it requested flushConversationStore=false.
    await this.flushConversationStore(
      true,
      fullCandidate,
      synchronizeCanonicalSession
    );

    // Clone only after pass 1 so the projection starts from the exact durable
    // Conversation candidate, including its derived Context snapshot.
    const historyCandidate = cloneSettings(fullCandidate);
    const projected = await this.projectKnowledgeBaseHistory(
      historyCandidate,
      options.strictKnowledgeBaseHistory
    );
    if (!projected) return fullCandidate;
    // History V2 is a reference-only projection. It cannot mutate or compact
    // the canonical Conversation, so no second Conversation write is allowed.
    return historyCandidate;
  }

  private async projectKnowledgeBaseHistory(
    candidate: CodexForObsidianSettings,
    strict = false
  ): Promise<boolean> {
    try {
      await persistAndCompactKnowledgeBaseHistory(
        this.plugin.getVaultPath(),
        this.plugin.getPluginDataDirName(),
        candidate
      );
      return true;
    } catch (error) {
      console.error("Codex knowledge history save failed", error);
      if (strict) throw error;
      return false;
    }
  }

  private async flushConversationStore(
    strict = true,
    candidate: CodexForObsidianSettings = this.plugin.settings,
    afterSessionPersisted?: (session: StoredSession) => void
  ): Promise<boolean> {
    try {
      await this.ensureRuntimePristineConversationSessionsCreated();
      await this.getConversationStore().persistSettingsSessions(
        candidate,
        afterSessionPersisted ? { afterSessionPersisted } : {}
      );
      return true;
    } catch (error) {
      console.error("EchoInk conversation store save failed", error);
      if (strict) throw error;
      return false;
    }
  }

  private async readPersistedSettingsDataStrict(): Promise<unknown> {
    return cloneJsonValue((await this.plugin.loadData()) ?? {});
  }

  private async persistSettingsDataCandidate(
    candidate: CodexForObsidianSettings,
    persistedBefore: unknown
  ): Promise<void> {
    const target = settingsForDataSave(candidate);
    try {
      await this.plugin.saveData(target);
      return;
    } catch (saveError) {
      let readback: unknown;
      try {
        readback = await this.readPersistedSettingsDataStrict();
      } catch (readbackError) {
        throw this.poisonSettingsRecovery(
          "settings_persist_failed",
          `settings saveData 结果未知，严格 readback 失败：${errorMessage(readbackError)}`
        );
      }
      if (stableJson(readback) === stableJson(target)) {
        return;
      }
      if (stableJson(readback) === stableJson(persistedBefore)) {
        throw saveError;
      }
      throw this.poisonSettingsRecovery(
        "settings_persist_failed",
        "settings saveData 抛错后的严格 readback 既不匹配提交前状态，也不匹配完整目标"
      );
    }
  }

  private async reconcileAndHydrateConversationSessions(): Promise<number> {
    const selection = await this.getConversationStore().resolveSelection();
    const reconciliation =
      await this.getConversationStore().reconcileCommittedSessionsAtStartup();
    const storedById = new Map(
      reconciliation.sessions.map((session) => [session.id, session])
    );
    const deletedIds = new Set(reconciliation.deletedSessionIds);
    const liveIds = new Set<string>();
    const retainedLiveSessions: StoredSession[] = [];
    let recoveredShells = 0;
    for (const session of this.plugin.settings.sessions) {
      if (liveIds.has(session.id)) {
        throw new Error(
          `Conversation recovery required: duplicate data shell ${session.id}`
        );
      }
      liveIds.add(session.id);
      if (deletedIds.has(session.id)) {
        recoveredShells += 1;
        continue;
      }
      const stored = storedById.get(session.id);
      if (!stored) {
        throw new Error(
          `Conversation recovery required: data shell ${session.id} lacks durable authority`
        );
      }
      applyStoredConversation(session, stored, {
        preserveSettingsProjection: selection.activeStore === "v2"
      });
      retainedLiveSessions.push(session);
    }
    this.plugin.settings.sessions = retainedLiveSessions;

    for (const stored of reconciliation.sessions) {
      if (liveIds.has(stored.id)) continue;
      const shell = cloneStoredSession(stored);
      shell.messages = [];
      delete shell.threadId;
      applyStoredConversation(shell, stored);
      this.plugin.settings.sessions.push(shell);
      liveIds.add(shell.id);
      recoveredShells += 1;
    }
    return recoveredShells;
  }

  private async shouldDeferLegacyConversationWritesUntilV2Migration(): Promise<boolean> {
    const selection = await this.getConversationStore().resolveSelection();
    return selection.activeStore === "v1"
      && this.plugin.settings.sessions.some(
        (session) =>
          session.messages.length > 0
          && !hasCompleteDurableConversationContextIdentity(session)
      );
  }

  private assertAuthoritativeLiveSession(session: StoredSession): void {
    const authoritative = this.plugin.settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    if (!authoritative || authoritative !== session) {
      throw new Error(
        `Conversation recovery required: conversation ${session.id} is not the authoritative live session`
      );
    }
  }

  private async ensureRuntimePristineConversationSessionsCreated(): Promise<void> {
    for (const entry of Array.from(this.runtimePristineConversationCreates.values())) {
      await this.ensureConversationSessionCreated(entry.session);
    }
  }

  private startPristineConversationCreate(
    entry: RuntimePristineConversationCreate
  ): Promise<void> {
    if (entry.created) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const pending = this.getConversationStore()
      .createPristineSession(entry.snapshot)
      .then(() => {
        entry.created = true;
      })
      .finally(() => {
        if (entry.pending === pending) entry.pending = null;
      });
    entry.pending = pending;
    return pending;
  }

  private recordMutationStorageRootPath(): string {
    return pluginDataDir(
      this.plugin.getVaultPath(),
      this.plugin.getPluginDataDirName()
    );
  }

  private async inspectRecordMutationConversation(
    intent: RecordMutationIntent
  ): Promise<RecordMutationConversationObservation> {
    const tombstone = await this.getConversationStore()
      .readConversationDeletionTombstone(intent.conversationId);
    if (tombstone) {
      return {
        status: "deleted",
        tombstoneId: tombstone.tombstoneId,
        digest: tombstone.digest
      };
    }
    const stored = await this.getConversationStore().readSession(
      intent.conversationId
    );
    if (!stored) return { status: "missing" };
    return {
      status: "present",
      generation: sessionGeneration(stored),
      commitId: stored.commitId?.trim() || null,
      contentRevision: createConversationContentRevision(stored)
    };
  }

  private getConversationStore(): FileConversationStoreRouter {
    const storageRootPath = pluginDataDir(
      this.plugin.getVaultPath(),
      this.plugin.getPluginDataDirName()
    );
    if (
      this.conversationStore
      && this.conversationStoreRootPath === storageRootPath
    ) {
      return this.conversationStore;
    }
    this.conversationStoreRootPath = storageRootPath;
    this.conversationStore = new FileConversationStoreRouter(
      storageRootPath
    );
    return this.conversationStore;
  }
}

export function settingsForDataSave(settings: CodexForObsidianSettings): CodexForObsidianSettings {
  const data = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  for (const session of data.sessions) {
    session.messages = [];
    delete session.threadId;
  }
  return data;
}

function prepareKnowledgeBaseHistoryMetadata(
  settings: CodexForObsidianSettings,
  now = Date.now()
): void {
  const session = settings.sessions.find(
    (item) => item.id === settings.knowledgeBase.sessionId
      && item.kind === "knowledge-base"
  );
  if (!session) return;
  const activeDate = activeKnowledgeBaseHistoryDate(
    session.messages,
    session.historyActiveDate,
    now
  );
  session.historyActiveDate = activeDate || undefined;
}

function cloneSettings(settings: CodexForObsidianSettings): CodexForObsidianSettings {
  return JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
}

function replaceStoredSessionInPlace(
  target: StoredSession,
  source: StoredSession
): void {
  for (const key of Object.keys(target) as Array<keyof StoredSession>) {
    delete target[key];
  }
  Object.assign(
    target,
    JSON.parse(JSON.stringify(source)) as StoredSession
  );
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function cloneKnowledgeBaseSettings(settings: KnowledgeBaseSettings): KnowledgeBaseSettings {
  const cloned = JSON.parse(JSON.stringify(settings)) as KnowledgeBaseSettings;
  ensureKnowledgeBaseNativeLifecycleRecoveryProjection(cloned);
  return cloned;
}

function knowledgeMaintenanceRunIdsPendingWorkflowRecovery(
  messages: ChatMessage[]
): Set<string> {
  return new Set(messages
    .filter((message) =>
      message.status === "running"
      && message.itemType === "knowledgeBase"
      && message.knowledgeBaseUi?.kind === "maintain-run"
      && typeof message.runId === "string"
      && message.runId.trim())
    .map((message) => message.runId!.trim()));
}

function cloneKnowledgeBaseSettingsReadback(
  readback: MaintenanceWorkflowSettingsReadback<KnowledgeBaseSettings>
): MaintenanceWorkflowSettingsReadback<KnowledgeBaseSettings> {
  return {
    settings: cloneKnowledgeBaseSettings(readback.settings),
    generation: readback.generation
  };
}

function knowledgeBaseSettingsGeneration(settings: KnowledgeBaseSettings): string {
  return `sha256:${createHash("sha256").update(stableJson(settings)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const MISSING_JSON_VALUE = Symbol("missing-json-value");
type JsonMergeData =
  | null
  | boolean
  | number
  | string
  | JsonMergeData[]
  | { [key: string]: JsonMergeData };
type MergeJsonValue = JsonMergeData | typeof MISSING_JSON_VALUE;

function mergeKnowledgeBaseSettingsAfterCas(
  base: KnowledgeBaseSettings,
  target: KnowledgeBaseSettings,
  later: KnowledgeBaseSettings
): { settings: KnowledgeBaseSettings; conflicts: string[] } {
  const conflicts: string[] = [];
  const merged = mergeJsonValue(
    base as unknown as JsonMergeData,
    target as unknown as JsonMergeData,
    later as unknown as JsonMergeData,
    "",
    conflicts
  );
  if (merged === MISSING_JSON_VALUE || !isJsonRecord(merged)) {
    return {
      settings: cloneKnowledgeBaseSettings(later),
      conflicts: conflicts.length ? conflicts : ["knowledgeBase"]
    };
  }
  return {
    settings: cloneKnowledgeBaseSettings(
      merged as unknown as KnowledgeBaseSettings
    ),
    conflicts
  };
}

function mergeJsonValue(
  base: MergeJsonValue,
  target: MergeJsonValue,
  later: MergeJsonValue,
  pathLabel: string,
  conflicts: string[]
): MergeJsonValue {
  if (mergeJsonValuesEqual(later, base)) return cloneMergeJsonValue(target);
  if (mergeJsonValuesEqual(target, base)) return cloneMergeJsonValue(later);
  if (mergeJsonValuesEqual(target, later)) return cloneMergeJsonValue(target);

  if (isJsonRecord(base) && isJsonRecord(target) && isJsonRecord(later)) {
    const merged: Record<string, JsonMergeData> = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(target),
      ...Object.keys(later)
    ]);
    for (const key of Array.from(keys).sort()) {
      const childPath = pathLabel ? `${pathLabel}.${key}` : key;
      const child = mergeJsonValue(
        jsonRecordValue(base, key),
        jsonRecordValue(target, key),
        jsonRecordValue(later, key),
        childPath,
        conflicts
      );
      if (child !== MISSING_JSON_VALUE) merged[key] = child;
    }
    return merged;
  }

  conflicts.push(pathLabel || "knowledgeBase");
  return cloneMergeJsonValue(later);
}

function mergeJsonValuesEqual(
  left: MergeJsonValue,
  right: MergeJsonValue
): boolean {
  if (left === MISSING_JSON_VALUE || right === MISSING_JSON_VALUE) {
    return left === right;
  }
  return stableJson(left) === stableJson(right);
}

function cloneMergeJsonValue(value: MergeJsonValue): MergeJsonValue {
  if (value === MISSING_JSON_VALUE) return MISSING_JSON_VALUE;
  return cloneJsonValue(value) as JsonMergeData;
}

function jsonRecordValue(
  record: Record<string, JsonMergeData>,
  key: string
): MergeJsonValue {
  return Object.prototype.hasOwnProperty.call(record, key)
    && record[key] !== undefined
    ? record[key]
    : MISSING_JSON_VALUE;
}

function isJsonRecord(
  value: MergeJsonValue
): value is Record<string, JsonMergeData> {
  return value !== MISSING_JSON_VALUE
    && typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function createAdvancingCanonicalSessionSynchronizer(
  live: CodexForObsidianSettings,
  candidate: CodexForObsidianSettings,
  liveBefore: CodexForObsidianSettings
): (canonicalSession: StoredSession) => void {
  const expectedBySessionId = new Map(
    liveBefore.sessions.map((session) => [
      session.id,
      cloneStoredSession(session)
    ] as const)
  );
  return (canonicalSession) => {
    const candidateSession = candidate.sessions.find(
      (session) => session.id === canonicalSession.id
    );
    if (candidateSession) {
      applyStoredConversation(candidateSession, canonicalSession, {
        preserveSettingsProjection: true
      });
    }
    const liveSession = live.sessions.find(
      (session) => session.id === canonicalSession.id
    );
    const expected = expectedBySessionId.get(canonicalSession.id);
    if (
      !liveSession
      || !expected
      || stableJson(liveSession) !== stableJson(expected)
    ) {
      return;
    }
    const liveMessages = liveSession.messages;
    applyStoredConversation(liveSession, canonicalSession, {
      preserveSettingsProjection: true
    });
    liveSession.messages = liveMessages;
    expectedBySessionId.set(
      canonicalSession.id,
      cloneStoredSession(liveSession)
    );
  };
}

function replaceKnowledgeBaseSettingsInPlace(
  target: KnowledgeBaseSettings,
  source: KnowledgeBaseSettings
): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, cloneKnowledgeBaseSettings(source));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyStoredConversation(
  target: StoredSession,
  stored: StoredSession,
  options: { preserveSettingsProjection?: boolean } = {}
): void {
  target.title = stored.title;
  target.kind = stored.kind;
  target.cwd = stored.cwd;
  target.messages = stored.messages;
  if (!options.preserveSettingsProjection) {
    target.backendBindings = stored.backendBindings;
    target.messagesHiddenBefore = stored.messagesHiddenBefore;
    target.historyActiveDate = stored.historyActiveDate;
    target.tokenUsage = stored.tokenUsage;
  }
  target.revision = stored.revision;
  target.generation = stored.generation;
  target.contextId = stored.contextId;
  target.contextStartsAfterMessageId = stored.contextStartsAfterMessageId;
  target.commitId = stored.commitId;
  target.workspaceFingerprint = stored.workspaceFingerprint;
  target.contextSnapshot = stored.contextSnapshot;
  target.rollingSummary = stored.rollingSummary;
  target.createdAt = stored.createdAt;
  target.updatedAt = stored.updatedAt;
}

function hasCompleteDurableConversationContextIdentity(
  session: StoredSession
): boolean {
  return Boolean(
    session.contextId?.trim()
    && session.commitId?.trim()
    && session.workspaceFingerprint?.trim()
    && session.cwd.trim()
  );
}

function assertRuntimePristineConversation(session: StoredSession): void {
  const contextId = session.contextId?.trim() ?? "";
  const commitId = session.commitId?.trim() ?? "";
  const storedWorkspaceFingerprint = session.workspaceFingerprint?.trim() ?? "";
  const hasRuntimeState = Boolean(
    session.threadId?.trim()
    || Object.keys(session.backendBindings ?? {}).length
    || session.contextStartsAfterMessageId?.trim()
    || session.contextSnapshot
    || session.rollingSummary
    || session.messagesHiddenBefore !== undefined
    || session.historyActiveDate
    || session.tokenUsage
  );
  if (
    !session.id.trim()
    || session.revision !== 1
    || session.generation !== 1
    || session.messages.length !== 0
    || hasRuntimeState
  ) {
    throw new Error(
      `Conversation recovery required: ${session.id || "unknown"} is not a runtime pristine conversation`
    );
  }
  if (session.kind === "knowledge-base") {
    const cwd = session.cwd.trim();
    const expectedFingerprint = cwd
      ? workspaceFingerprint({ vaultPath: cwd, cwd })
      : "";
    if (
      !cwd
      || !contextId
      || !commitId
      || contextId === commitId
      || storedWorkspaceFingerprint !== expectedFingerprint
    ) {
      throw new Error(
        `Conversation recovery required: ${session.id} has an invalid pristine knowledge workspace`
      );
    }
    return;
  }
  if (
    (session.kind !== undefined && session.kind !== "chat")
    || session.cwd.trim()
    || contextId
    || commitId
    || storedWorkspaceFingerprint
  ) {
    throw new Error(
      `Conversation recovery required: ${session.id} has an invalid pristine chat workspace`
    );
  }
}

function assertConversationContextIdentityMatches(
  stored: StoredSession,
  live: StoredSession
): void {
  const normalized = (value: string | undefined): string => value?.trim() ?? "";
  if (
    stored.id !== live.id
    || (stored.kind ?? "chat") !== (live.kind ?? "chat")
    || sessionGeneration(stored) !== sessionGeneration(live)
    || normalized(stored.contextId) !== normalized(live.contextId)
    || normalized(stored.contextStartsAfterMessageId)
      !== normalized(live.contextStartsAfterMessageId)
    || normalized(stored.commitId) !== normalized(live.commitId)
    || normalized(stored.workspaceFingerprint)
      !== normalized(live.workspaceFingerprint)
    || stored.cwd !== live.cwd
  ) {
    throw new Error(
      `Conversation recovery required: durable identity for ${live.id} does not match the live session`
    );
  }
}

function cloneStoredSession(session: StoredSession): StoredSession {
  return JSON.parse(JSON.stringify(session)) as StoredSession;
}

function localRunCommitResult(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}
