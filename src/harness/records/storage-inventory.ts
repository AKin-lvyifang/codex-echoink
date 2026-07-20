import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath
} from "node:fs/promises";
import * as path from "node:path";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  createConversationPayloadKeyV2,
  parseConversationDeletionTombstone,
  type ConversationDeletionTombstoneV1
} from "../conversation/conversation-store";
import {
  createConversationProductMessageRevision
} from "../lifecycle/conversation-migration-projection";
import type { ChatMessage } from "../../settings/settings";
import {
  isSafeConversationSessionId,
  legacyConversationPathPart
} from "../conversation/storage-contract";
import {
  isSafeNativeExecutionTransport,
  nativeRetirementSourceIdentityState,
  nativeRetirementTargetState,
  type NativeExecutionRecord
} from "../contracts/native-execution";
import {
  assertRecordMutationChainCompleteness,
  assertRecordMutationTransition,
  parseRecordMutationRevision,
  RECORD_MUTATION_MAX_REVISIONS,
  RECORD_MUTATION_SCHEMA_VERSION,
  type RecordMutationRevision
} from "../lifecycle/record-mutation-contract";
import {
  RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY,
  inspectRunRecordRetentionJournalSnapshot
} from "../ledger/run-record-retention";
import {
  RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY,
  inspectRawGcQuarantineJournalSnapshot
} from "./raw-gc-quarantine";
import { NATIVE_EXECUTION_STORE_SCHEMA_VERSION } from "../native/native-execution-store";
import {
  createStorageInventoryOpaqueRef,
  validateStorageInventoryReportInput,
  type StorageInventoryFinding,
  type StorageInventoryFindingCategory,
  type StorageInventoryFindingMetadata,
  type StorageInventoryFindingSeverity,
  type StorageInventoryLocalSourceId,
  type StorageInventoryRelation,
  type StorageInventoryReportInput,
  type StorageInventorySource,
  type StorageInventorySourceStatus
} from "./storage-inventory-contract";
import {
  scanNativeProviderInventory,
  type NativeInventoryScope,
  type NativeProviderId,
  type NativeProviderProbe
} from "./native-provider-inventory";

const CURRENT_SETTINGS_SCHEMA = 39;
const CURRENT_CONVERSATION_SCHEMA = 1;
const CURRENT_HISTORY_SCHEMA = 2;
const CURRENT_NATIVE_SCHEMA = NATIVE_EXECUTION_STORE_SCHEMA_VERSION;
const RECORD_MUTATION_CHAIN_TOKEN_PATTERN = /^mutation-[a-f0-9]{24}$/;
const RECORD_MUTATION_ENTRY_PATTERN = /^entry-([0-9]{16})\.json$/;
const LOCAL_SOURCE_IDS: readonly StorageInventoryLocalSourceId[] = [
  "data-json",
  "conversations",
  "history",
  "harness-runs",
  "run-record-retention",
  "raw-gc-quarantine",
  "record-mutations",
  "native-store",
  "raw"
];

export interface ReadOnlyStats {
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReadOnlyDirEntry {
  readonly name: string;
  isFile?(): boolean;
  isDirectory?(): boolean;
  isSymbolicLink?(): boolean;
}

/**
 * Deliberately excludes write, rename, remove, open, and provider cleanup
 * methods. Raw scanning uses only `readdir` and `lstat`.
 */
export interface ReadOnlyFs {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  readdir(
    directoryPath: string,
    options: { withFileTypes: true }
  ): Promise<readonly (ReadOnlyDirEntry | string)[]>;
  lstat(filePath: string): Promise<ReadOnlyStats>;
  realpath(filePath: string): Promise<string>;
}

export interface StorageInventoryOptions {
  vaultPath: string;
  pluginDir?: string;
  fs?: ReadOnlyFs;
  now?: () => number;
  nativeScope?: NativeInventoryScope;
  nativeProviderProbes?: Partial<Record<NativeProviderId, NativeProviderProbe>>;
}

interface MessageFact {
  id: string;
  createdAt: number;
  revision: string;
  rawRef?: string;
  runId?: string;
}

interface SessionFact {
  id: string;
  messageIds: Set<string>;
  messages: Map<string, MessageFact>;
  messageOrder: string[];
  duplicateMessageIds: Set<string>;
  messageCount: number;
  rawReferences: RawReference[];
  createdAt: number;
  updatedAt: number;
  title?: string;
  kind?: string;
  historyActiveDate?: string;
  generation?: number;
  contextId?: string;
  contextStartsAfterMessageId?: string;
  commitId?: string;
  workspaceFingerprint?: string;
}

interface RawReference {
  sourceId: StorageInventoryLocalSourceId;
  ownerRef: string;
  rawRef: string;
}

interface DataFacts {
  sessions: Map<string, SessionFact>;
  rawReferences: RawReference[];
}

interface ConversationFacts {
  sessions: Map<string, SessionFact>;
  deletionTombstones: Map<string, ConversationDeletionTombstoneV1>;
  messageOwners: Map<string, string[]>;
  rawReferences: RawReference[];
}

interface HistoryReferenceFact {
  conversationId: string;
  messageId: string;
  messageRevision: string;
  date: string;
  ownerRef: string;
}

interface HistoryReferenceRowV2 {
  conversationId: string;
  messageId: string;
  messageRevision: string;
}

interface HistoryGenerationFileFact {
  relativePath: string;
  digest: string;
  rowCount: number;
}

interface HistoryFacts {
  sessions: Map<string, SessionFact>;
  references: HistoryReferenceFact[];
  rawReferences: RawReference[];
  activeSourceRevision?: string;
  activeGenerationId?: string;
}

interface RunFacts {
  runIds: Set<string>;
  terminalRunIds: Set<string>;
  locallyCommittedRunIds: Set<string>;
}

interface RunRecordRetentionFacts {
  transactionCount: number;
}

interface RawGcQuarantineFacts {
  transactionCount: number;
}

interface NativeFacts {
  records: NativeExecutionRecord[];
}

interface RecordMutationFacts {
  records: Map<string, RecordMutationRevision>;
}

interface ScanContext {
  fs: ReadOnlyFs;
  vaultPath: string;
  pluginRoot: string;
  realPluginRoot?: string;
}

interface SourceScan<T> {
  accumulator: SourceAccumulator;
  facts: T;
}

interface ReadTextResult {
  text: string;
  stats: ReadOnlyStats;
}

interface ConversationPayloadPointers {
  valid: boolean;
  payloadVersion?: 2;
  activePayloadKey?: string;
  activePayloadCommitId?: string;
  previousPayloadKey?: string;
  previousPayloadCommitId?: string;
}

interface ConversationPayloadScan {
  messageRows: unknown[];
  snapshotRows: unknown[];
}

const NODE_READ_ONLY_FS: ReadOnlyFs = {
  async readFile(filePath, encoding) {
    return nodeReadFile(filePath, encoding);
  },
  async readdir(directoryPath, options) {
    return nodeReaddir(directoryPath, options);
  },
  async lstat(filePath) {
    return nodeLstat(filePath);
  },
  async realpath(filePath) {
    return nodeRealpath(filePath);
  }
};

/**
 * Produces the metadata-only input consumed by the report builder. This
 * function has no output path and no write-capable dependency.
 */
export async function scanStorageInventory(
  options: StorageInventoryOptions
): Promise<StorageInventoryReportInput> {
  const generatedAt = safeTimestamp((options.now ?? Date.now)());
  const fs = options.fs ?? NODE_READ_ONLY_FS;
  const nativeScope = options.nativeScope ?? "linked";
  const rootResolution = resolvePluginRoot(options.vaultPath, options.pluginDir);
  const scopePluginDir = rootResolution.pluginDir;
  const context: ScanContext = {
    fs,
    vaultPath: path.resolve(options.vaultPath),
    pluginRoot: rootResolution.pluginRoot
  };

  if (!rootResolution.safe) {
    return validateStorageInventoryReportInput(
      blockedRootReport(generatedAt, scopePluginDir, nativeScope, options.vaultPath)
    );
  }

  const rootBoundaryFinding = await verifyRootBoundary(context);
  if (rootBoundaryFinding) {
    return validateStorageInventoryReportInput(
      blockedRootReport(
        generatedAt,
        scopePluginDir,
        nativeScope,
        options.vaultPath,
        rootBoundaryFinding
      )
    );
  }

  const [
    data,
    conversations,
    history,
    runs,
    runRecordRetention,
    rawGcQuarantine,
    recordMutations,
    native
  ] =
    await Promise.all([
    scanDataJson(context),
    scanConversations(context),
    scanHistory(context),
    scanHarnessRuns(context),
    scanRunRecordRetention(context),
    scanRawGcQuarantine(context),
    scanRecordMutations(context),
    scanNativeStore(context)
  ]);
  const relations: StorageInventoryRelation[] = [];
  const findings = [
    ...data.accumulator.findings,
    ...conversations.accumulator.findings,
    ...history.accumulator.findings,
    ...runs.accumulator.findings,
    ...runRecordRetention.accumulator.findings,
    ...rawGcQuarantine.accumulator.findings,
    ...recordMutations.accumulator.findings,
    ...native.accumulator.findings
  ];

  correlateDataAndConversations(data.facts, conversations.facts, relations, findings);
  correlateHistoryAndConversations(
    history.facts,
    conversations.facts,
    relations,
    findings
  );
  correlateNativeRecords(
    native.facts,
    runs.facts,
    conversations.facts,
    recordMutations.facts,
    relations,
    findings
  );

  const raw = await scanRawMetadata(context, [
    ...data.facts.rawReferences,
    ...conversations.facts.rawReferences
  ]);
  findings.push(...raw.accumulator.findings);
  relations.push(...raw.relations);

  const probes = options.nativeProviderProbes ?? {};
  const providerInventory = await scanNativeProviderInventory({
    vaultPath: context.vaultPath,
    scope: nativeScope,
    linkedRecords: native.facts.records,
    probes
  });
  findings.push(...providerInventory.findings);
  relations.push(...providerInventory.relations);

  const sources = [
    data.accumulator.finalize(),
    conversations.accumulator.finalize(),
    history.accumulator.finalize(),
    runs.accumulator.finalize(),
    runRecordRetention.accumulator.finalize(),
    rawGcQuarantine.accumulator.finalize(),
    recordMutations.accumulator.finalize(),
    native.accumulator.finalize(),
    raw.accumulator.finalize()
  ];
  const uniqueFindings = deduplicateFindings(findings);
  const input: StorageInventoryReportInput = {
    generatedAt,
    scope: {
      vaultRef: createStorageInventoryOpaqueRef("vault", context.vaultPath),
      pluginDir: scopePluginDir,
      nativeScope
    },
    sources,
    providers: providerInventory.providers,
    relations: deduplicateRelations(relations),
    findings: uniqueFindings,
    migrationPreview: buildMigrationPreview(sources, providerInventory.providers, uniqueFindings)
  };
  return validateStorageInventoryReportInput(input);
}

async function scanDataJson(context: ScanContext): Promise<SourceScan<DataFacts>> {
  const accumulator = new SourceAccumulator("data-json", context.pluginRoot);
  const facts: DataFacts = {
    sessions: new Map(),
    rawReferences: []
  };
  const target = path.join(context.pluginRoot, "data.json");
  const read = await readTextFile(context, accumulator, target, false);
  if (!read) {
    accumulator.markUnavailable("data-json-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  const parsed = parseJsonObject(read.text, accumulator, "invalid-data-json", target);
  if (!parsed) return { accumulator, facts };
  const version = finiteInteger(parsed.settingsVersion);
  accumulator.schemaVersion = version === null ? null : String(version);
  const knowledgeSettings = objectRecord(parsed.knowledgeBase);
  accumulator.observeRecordMetadata("data-root", {
    settingsVersion: version,
    activeSessionId: stringOrNull(parsed.activeSessionId),
    knowledgeSessionId: stringOrNull(knowledgeSettings?.sessionId),
    historyRetentionDays: finiteInteger(
      knowledgeSettings?.historyRetentionDays
    )
  });
  if (version !== null && version > CURRENT_SETTINGS_SCHEMA) {
    accumulator.futureSchemaCount += 1;
    accumulator.markPartial("future-schema");
    accumulator.addFinding({
      code: "future-schema",
      category: "future-schema",
      severity: "blocking",
      recordRaw: "data-json",
      blocksMigration: true
    });
  }
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  if (!Array.isArray(parsed.sessions)) {
    accumulator.addCorrupt("data-sessions-invalid", "sessions");
  }
  const globalMessageOwners = new Map<string, string[]>();
  const dataSessionIds = new Set<string>();
  const legacyIdOwners = new Map<string, Set<string>>();
  for (const [index, value] of sessions.entries()) {
    const session = objectRecord(value);
    if (!session || typeof session.id !== "string" || !session.id) {
      accumulator.addCorrupt("data-session-invalid", `session:${index}`);
      continue;
    }
    const sessionId = session.id;
    observeConversationLegacyId(legacyIdOwners, sessionId);
    if (!isSafeConversationSessionId(sessionId)) {
      accumulator.addCorrupt(
        "conversation-session-id-unsafe",
        `data-session:${sessionId}`
      );
    }
    if (dataSessionIds.has(sessionId)) {
      accumulator.addCorrupt("data-session-duplicate-id", sessionId);
      continue;
    }
    dataSessionIds.add(sessionId);
    accumulator.observeRecordMetadata(
      "data-session",
      sessionMetadataProjection(session)
    );
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const messageFacts = collectMessageFacts(
      messages,
      accumulator,
      "data-json",
      `session:${sessionId}`
    );
    const sessionRef = opaque("data-session", sessionId);
    const rawReferences = messageFacts
      .filter((message) => message.rawRef)
      .map((message) => ({
        sourceId: "data-json" as const,
        ownerRef: opaque("data-message", `${sessionId}:${message.id}`),
        rawRef: message.rawRef!
      }));
    facts.rawReferences.push(...rawReferences);
    const messageIds = new Set(messageFacts.map((message) => message.id));
    facts.sessions.set(sessionId, {
      id: sessionId,
      messageIds,
      messages: messageFactMap(messageFacts),
      messageOrder: messageFacts.map((message) => message.id),
      duplicateMessageIds: duplicateMessageFactIds(messageFacts),
      messageCount: messageFacts.length,
      rawReferences,
      createdAt: timestampOrZero(session.createdAt),
      updatedAt: timestampOrZero(session.updatedAt),
      ...(nonEmptyStringOrNull(session.title)
        ? { title: nonEmptyStringOrNull(session.title)! }
        : {}),
      ...(nonEmptyStringOrNull(session.kind)
        ? { kind: nonEmptyStringOrNull(session.kind)! }
        : {}),
      ...(nonEmptyStringOrNull(session.historyActiveDate)
        ? { historyActiveDate: nonEmptyStringOrNull(session.historyActiveDate)! }
        : {}),
      generation: conversationGeneration(session),
      ...(nonEmptyStringOrNull(session.contextId)
        ? { contextId: nonEmptyStringOrNull(session.contextId)! }
        : {}),
      ...(nonEmptyStringOrNull(session.contextStartsAfterMessageId)
        ? {
          contextStartsAfterMessageId:
            nonEmptyStringOrNull(session.contextStartsAfterMessageId)!
        }
        : {}),
      ...(nonEmptyStringOrNull(session.commitId)
        ? { commitId: nonEmptyStringOrNull(session.commitId)! }
        : {}),
      ...(nonEmptyStringOrNull(session.workspaceFingerprint)
        ? { workspaceFingerprint: nonEmptyStringOrNull(session.workspaceFingerprint)! }
        : {})
    });
    accumulator.addTimestamp(session.createdAt);
    accumulator.addTimestamp(session.updatedAt);
    for (const message of messageFacts) {
      accumulator.addTimestamp(message.createdAt);
      const owners = globalMessageOwners.get(message.id) ?? [];
      owners.push(session.id);
      globalMessageOwners.set(message.id, owners);
    }
    if (typeof session.threadId === "string" && session.threadId) {
      accumulator.incrementMetric("legacy-thread-binding-count");
    }
    const bindings = objectRecord(session.backendBindings);
    accumulator.incrementMetric("backend-binding-count", bindings ? Object.keys(bindings).length : 0);
    accumulator.incrementMetric("message-count", messageFacts.length);
    accumulator.incrementMetric("raw-reference-count", rawReferences.length);
    void sessionRef;
  }
  for (const [messageId, owners] of globalMessageOwners) {
    if (owners.length < 2) continue;
    accumulator.addFinding({
      code: "duplicate-message-id",
      category: "ambiguous",
      severity: "warning",
      recordRaw: messageId,
      count: owners.length,
      blocksMigration: false
    });
  }
  for (const [legacyPathPart, owners] of legacyIdOwners) {
    if (owners.size < 2) continue;
    accumulator.addFinding({
      code: "conversation-session-id-collision",
      category: "ambiguous",
      severity: "blocking",
      recordRaw: legacyPathPart,
      relatedRaw: [...owners].sort(),
      count: owners.size,
      blocksMigration: true
    });
    accumulator.markPartial("conversation-session-id-collision");
  }
  accumulator.recordCount = facts.sessions.size;
  accumulator.incrementMetric("session-count", facts.sessions.size);
  return { accumulator, facts };
}

async function scanConversations(
  context: ScanContext
): Promise<SourceScan<ConversationFacts>> {
  const accumulator = new SourceAccumulator("conversations", context.pluginRoot);
  const facts: ConversationFacts = {
    sessions: new Map(),
    deletionTombstones: new Map(),
    messageOwners: new Map(),
    rawReferences: []
  };
  const legacyIdOwners = new Map<string, Set<string>>();
  const root = path.join(context.pluginRoot, "conversations");
  const rootEntries = await listDirectory(context, accumulator, root, false);
  if (!rootEntries) {
    accumulator.markUnavailable("conversation-store-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  facts.deletionTombstones =
    await scanConversationDeletionTombstones(
      context,
      accumulator,
      root
    );

  const indexPath = path.join(root, "index.json");
  const indexRead = await readTextFile(context, accumulator, indexPath, false);
  let indexSessions: Array<Record<string, unknown>> = [];
  if (!indexRead) {
    accumulator.missingCount += 1;
    accumulator.markPartial("conversation-index-missing");
    accumulator.addFinding({
      code: "conversation-index-drift",
      category: "missing",
      severity: "blocking",
      recordRaw: "index",
      blocksMigration: true
    });
  } else {
    const index = parseJsonObject(
      indexRead.text,
      accumulator,
      "conversation-index-corrupt",
      indexPath
    );
    if (index) {
      const version = finiteInteger(index.version);
      accumulator.schemaVersion = version === null ? null : String(version);
      accumulator.observeRecordMetadata("conversation-index", {
        version,
        updatedAt: finiteTimestamp(index.updatedAt)
      });
      if (version !== null && version > CURRENT_CONVERSATION_SCHEMA) {
        accumulator.futureSchemaCount += 1;
        accumulator.markPartial("future-schema");
        accumulator.addFinding({
          code: "future-schema",
          category: "future-schema",
          severity: "blocking",
          recordRaw: "index",
          blocksMigration: true
        });
      }
      if (Array.isArray(index.sessions)) {
        index.sessions.forEach((value, indexPosition) => {
          const session = objectRecord(value);
          if (!session) {
            accumulator.addCorrupt(
              "conversation-index-entry-invalid",
              `index-entry:${indexPosition}`
            );
            return;
          }
          indexSessions.push(session);
        });
      } else {
        accumulator.addCorrupt("conversation-index-invalid", "index");
      }
    }
  }

  const sessionsRoot = path.join(root, "sessions");
  const sessionDirs = await listDirectory(context, accumulator, sessionsRoot, false) ?? [];
  const actualByDirectory = new Map<string, SessionFact>();
  for (const directoryName of sessionDirs.sort()) {
    if (!isSafeConversationSessionId(directoryName)) {
      accumulator.addCorrupt(
        "conversation-session-id-unsafe",
        `directory:${directoryName}`
      );
    }
    const sessionDir = path.join(sessionsRoot, directoryName);
    const stats = await safeLstat(context, accumulator, sessionDir, false);
    if (!stats || !stats.isDirectory()) continue;
    const metadataPath = path.join(sessionDir, "metadata.json");
    const metadataRead = await readTextFile(context, accumulator, metadataPath, false);
    const metadata = metadataRead
      ? parseJsonObject(metadataRead.text, accumulator, "conversation-metadata-corrupt", metadataPath)
      : null;
    if (!metadataRead) {
      accumulator.missingCount += 1;
      accumulator.addFinding({
        code: "conversation-metadata-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: directoryName,
        blocksMigration: true
      });
    }
    const sessionId = typeof metadata?.id === "string" && metadata.id
      ? metadata.id
      : directoryName;
    observeConversationLegacyId(legacyIdOwners, sessionId);
    if (!isSafeConversationSessionId(sessionId)) {
      accumulator.addCorrupt(
        "conversation-session-id-unsafe",
        `metadata:${sessionId}`
      );
    }
    if (
      typeof metadata?.id === "string"
      && metadata.id
      && metadata.id !== directoryName
    ) {
      accumulator.addCorrupt(
        "conversation-metadata-directory-drift",
        directoryName
      );
    }
    if (metadata) {
      accumulator.observeRecordMetadata(
        "conversation-session",
        sessionMetadataProjection(metadata)
      );
    }
    const payloadPointers = validateConversationPayloadPointers(
      metadata,
      accumulator,
      metadataPath
    );
    const payload = await scanConversationPayloads(
      context,
      accumulator,
      sessionDir,
      sessionId,
      payloadPointers
    );
    payload.snapshotRows.forEach((snapshot, index) => {
      accumulator.observeRecordMetadata("conversation-snapshot", {
        sessionId,
        index,
        metadata: snapshotMetadataProjection(snapshot)
      });
    });
    const messageFacts = collectMessageFacts(
      payload.messageRows,
      accumulator,
      "conversations",
      `session:${sessionId}`
    );
    const rawReferences = messageFacts
      .filter((message) => message.rawRef)
      .map((message) => ({
        sourceId: "conversations" as const,
        ownerRef: opaque("conversation-message", `${sessionId}:${message.id}`),
        rawRef: message.rawRef!
      }));
    const fact: SessionFact = {
      id: sessionId,
      messageIds: new Set(messageFacts.map((message) => message.id)),
      messages: messageFactMap(messageFacts),
      messageOrder: messageFacts.map((message) => message.id),
      duplicateMessageIds: duplicateMessageFactIds(messageFacts),
      messageCount: messageFacts.length,
      rawReferences,
      createdAt: timestampOrZero(metadata?.createdAt),
      updatedAt: timestampOrZero(metadata?.updatedAt),
      ...(nonEmptyStringOrNull(metadata?.title)
        ? { title: nonEmptyStringOrNull(metadata?.title)! }
        : {}),
      ...(nonEmptyStringOrNull(metadata?.kind)
        ? { kind: nonEmptyStringOrNull(metadata?.kind)! }
        : {}),
      ...(nonEmptyStringOrNull(metadata?.historyActiveDate)
        ? { historyActiveDate: nonEmptyStringOrNull(metadata?.historyActiveDate)! }
        : {}),
      generation: conversationGeneration(metadata),
      ...(nonEmptyStringOrNull(metadata?.contextId)
        ? { contextId: nonEmptyStringOrNull(metadata?.contextId)! }
        : {}),
      ...(nonEmptyStringOrNull(metadata?.contextStartsAfterMessageId)
        ? {
          contextStartsAfterMessageId:
            nonEmptyStringOrNull(metadata?.contextStartsAfterMessageId)!
        }
        : {}),
      ...(nonEmptyStringOrNull(metadata?.commitId)
        ? { commitId: nonEmptyStringOrNull(metadata?.commitId)! }
        : {}),
      ...(nonEmptyStringOrNull(metadata?.workspaceFingerprint)
        ? { workspaceFingerprint: nonEmptyStringOrNull(metadata?.workspaceFingerprint)! }
        : {})
    };
    actualByDirectory.set(directoryName, fact);
    if (facts.sessions.has(sessionId)) {
      accumulator.addCorrupt("conversation-session-duplicate-id", sessionId);
    } else {
      facts.sessions.set(sessionId, fact);
    }
    facts.rawReferences.push(...rawReferences);
    accumulator.addTimestamp(metadata?.createdAt);
    accumulator.addTimestamp(metadata?.updatedAt);
    accumulator.incrementMetric("message-count", messageFacts.length);
    accumulator.incrementMetric("raw-reference-count", rawReferences.length);
    for (const message of messageFacts) {
      accumulator.addTimestamp(message.createdAt);
      const owners = facts.messageOwners.get(message.id) ?? [];
      owners.push(sessionId);
      facts.messageOwners.set(message.id, owners);
    }
  }

  const indexedSessionIds = new Set<string>();
  for (const summary of indexSessions) {
    if (typeof summary.sessionId !== "string" || !summary.sessionId) {
      accumulator.addCorrupt("conversation-index-entry-invalid", "index-entry");
      continue;
    }
    observeConversationLegacyId(legacyIdOwners, summary.sessionId);
    if (!isSafeConversationSessionId(summary.sessionId)) {
      accumulator.addCorrupt(
        "conversation-session-id-unsafe",
        `index:${summary.sessionId}`
      );
      continue;
    }
    accumulator.observeRecordMetadata("conversation-index-entry", {
      sessionId: summary.sessionId,
      kind: stringOrNull(summary.kind),
      messageCount: finiteInteger(summary.messageCount),
      updatedAt: finiteTimestamp(summary.updatedAt)
    });
    if (indexedSessionIds.has(summary.sessionId)) {
      accumulator.addCorrupt("conversation-index-duplicate-id", summary.sessionId);
      continue;
    }
    indexedSessionIds.add(summary.sessionId);
    const directoryName = summary.sessionId;
    const actual = actualByDirectory.get(directoryName)
      ?? facts.sessions.get(summary.sessionId);
    const indexRef = opaque("conversation-index-entry", summary.sessionId);
    const sessionRef = opaque("conversation-session", summary.sessionId);
    const status = actual ? "linked" : "missing";
    accumulator.relations.push({
      kind: "conversation-index-membership",
      from: { sourceId: "conversations", entityType: "index-entry", ref: indexRef },
      to: { sourceId: "conversations", entityType: "session", ref: sessionRef },
      status
    });
    if (!actual) {
      accumulator.missingCount += 1;
      accumulator.addFinding({
        code: "conversation-index-drift",
        category: "missing",
        severity: "blocking",
        recordRaw: summary.sessionId,
        blocksMigration: true
      });
      continue;
    }
    const indexedCount = finiteInteger(summary.messageCount);
    if (indexedCount !== null && indexedCount !== actual.messageCount) {
      accumulator.addFinding({
        code: "conversation-index-count-drift",
        category: "ambiguous",
        severity: "warning",
        recordRaw: summary.sessionId,
        metadata: [
          { name: "indexed-count", value: indexedCount },
          { name: "actual-count", value: actual.messageCount }
        ],
        blocksMigration: false
      });
    }
  }
  for (const session of facts.sessions.values()) {
    if (indexedSessionIds.has(session.id)) continue;
    accumulator.addFinding({
      code: "conversation-directory-unindexed",
      category: "unlinked",
      severity: "warning",
      recordRaw: session.id,
      blocksMigration: false
    });
  }
  for (const [messageId, owners] of facts.messageOwners) {
    if (owners.length < 2) continue;
    accumulator.addFinding({
      code: "duplicate-message-id",
      category: "ambiguous",
      severity: "warning",
      recordRaw: messageId,
      count: owners.length,
      blocksMigration: false
    });
  }
  for (const [legacyPathPart, owners] of legacyIdOwners) {
    if (owners.size < 2) continue;
    accumulator.addFinding({
      code: "conversation-session-id-collision",
      category: "ambiguous",
      severity: "blocking",
      recordRaw: legacyPathPart,
      relatedRaw: [...owners].sort(),
      count: owners.size,
      blocksMigration: true
    });
    accumulator.markPartial("conversation-session-id-collision");
  }
  accumulator.recordCount =
    facts.sessions.size + facts.deletionTombstones.size;
  accumulator.incrementMetric("session-count", facts.sessions.size);
  accumulator.incrementMetric(
    "deletion-tombstone-count",
    facts.deletionTombstones.size
  );
  accumulator.relations.push(...[]);
  return { accumulator, facts };
}

async function scanConversationDeletionTombstones(
  context: ScanContext,
  accumulator: SourceAccumulator,
  conversationRoot: string
): Promise<Map<string, ConversationDeletionTombstoneV1>> {
  const tombstones = new Map<string, ConversationDeletionTombstoneV1>();
  const root = path.join(conversationRoot, "deletions");
  const entries = await listDirectory(
    context,
    accumulator,
    root,
    true
  );
  if (!entries) return tombstones;
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) {
      accumulator.addCorrupt(
        "conversation-deletion-tombstone-entry-unsafe",
        name
      );
      continue;
    }
    const conversationId = name.slice(0, -".json".length);
    if (!isSafeConversationSessionId(conversationId)) {
      accumulator.addCorrupt(
        "conversation-deletion-tombstone-entry-unsafe",
        name
      );
      continue;
    }
    const tombstonePath = path.join(root, name);
    const read = await readTextFile(
      context,
      accumulator,
      tombstonePath,
      false
    );
    if (!read) continue;
    let tombstone: ConversationDeletionTombstoneV1;
    try {
      tombstone = parseConversationDeletionTombstone(
        JSON.parse(read.text) as unknown
      );
    } catch {
      accumulator.addCorrupt(
        "conversation-deletion-tombstone-corrupt",
        tombstonePath
      );
      continue;
    }
    if (
      tombstone.conversationId !== conversationId
      || tombstones.has(conversationId)
    ) {
      accumulator.addCorrupt(
        "conversation-deletion-tombstone-identity-mismatch",
        tombstonePath
      );
      continue;
    }
    tombstones.set(conversationId, tombstone);
    accumulator.observeRecordMetadata(
      "conversation-deletion-tombstone",
      {
        conversationId,
        mutationId: tombstone.mutationId,
        tombstoneId: tombstone.tombstoneId,
        sourceGeneration: tombstone.sourceGeneration,
        sourceCommitId: tombstone.sourceCommitId,
        sourceContentRevision: tombstone.sourceContentRevision,
        deletedAt: tombstone.deletedAt,
        digest: tombstone.digest
      }
    );
    accumulator.addTimestamp(tombstone.deletedAt);
  }
  return tombstones;
}

function validateConversationPayloadPointers(
  metadata: Record<string, unknown> | null,
  accumulator: SourceAccumulator,
  metadataPath: string
): ConversationPayloadPointers {
  if (!metadata) return { valid: true };
  const payloadVersionValue = metadata.payloadVersion;
  const activeValue = metadata.payloadKey;
  const previousValue = metadata.previousPayloadKey;
  const previousCommitValue = metadata.previousPayloadCommitId;
  if (
    payloadVersionValue === undefined
    && activeValue === undefined
    && previousValue === undefined
    && previousCommitValue === undefined
  ) {
    return { valid: true };
  }
  const activePayloadKey = typeof activeValue === "string" ? activeValue : "";
  const previousPayloadKey = typeof previousValue === "string" ? previousValue : "";
  const commitId = nonEmptyStringOrNull(metadata.commitId);
  const previousPayloadCommitId = nonEmptyStringOrNull(previousCommitValue);
  const structurallyValid = (
    (payloadVersionValue === undefined || payloadVersionValue === 2)
    && (activeValue === undefined || typeof activeValue === "string")
    && (previousValue === undefined || typeof previousValue === "string")
    && (
      previousCommitValue === undefined
      || (
        typeof previousCommitValue === "string"
        && Boolean(previousPayloadCommitId)
      )
    )
    && isConversationPayloadKey(activePayloadKey)
    && (!previousPayloadKey || isConversationPayloadKey(previousPayloadKey))
    && previousPayloadKey !== activePayloadKey
    && Boolean(commitId)
  );
  const valid = structurallyValid && (
    payloadVersionValue === 2
      ? Boolean(previousPayloadKey) === Boolean(previousPayloadCommitId)
      : (
        previousCommitValue === undefined
        && conversationPayloadKey(commitId!) === activePayloadKey
      )
  );
  if (!valid) {
    accumulator.addCorrupt(
      "conversation-payload-pointer-invalid",
      metadataPath
    );
    return { valid: false };
  }
  return {
    valid: true,
    ...(payloadVersionValue === 2 ? { payloadVersion: 2 as const } : {}),
    activePayloadKey,
    activePayloadCommitId: commitId!,
    ...(previousPayloadKey ? { previousPayloadKey } : {}),
    ...(previousPayloadCommitId ? { previousPayloadCommitId } : {})
  };
}

async function scanConversationPayloads(
  context: ScanContext,
  accumulator: SourceAccumulator,
  sessionDir: string,
  sessionId: string,
  pointers: ConversationPayloadPointers
): Promise<ConversationPayloadScan> {
  const legacyMessagesPath = path.join(sessionDir, "messages.jsonl");
  const legacySnapshotsPath = path.join(sessionDir, "snapshots.jsonl");
  const payloadDirectories = await scanConversationPayloadMetadata(
    context,
    accumulator,
    sessionDir,
    pointers.activePayloadKey,
    pointers.previousPayloadKey
  );

  if (!pointers.valid) {
    await Promise.all([
      observeMetadataOnlyFile(
        context,
        accumulator,
        legacyMessagesPath
      ),
      observeMetadataOnlyFile(
        context,
        accumulator,
        legacySnapshotsPath
      )
    ]);
    return { messageRows: [], snapshotRows: [] };
  }

  if (!pointers.activePayloadKey) {
    return {
      messageRows: await readJsonlFile(
        context,
        accumulator,
        legacyMessagesPath,
        "conversation-messages-corrupt",
        false
      ),
      snapshotRows: await readJsonlFile(
        context,
        accumulator,
        legacySnapshotsPath,
        "conversation-snapshots-corrupt",
        true
      )
    };
  }

  await Promise.all([
    observeMetadataOnlyFile(
      context,
      accumulator,
      legacyMessagesPath
    ),
    observeMetadataOnlyFile(
      context,
      accumulator,
      legacySnapshotsPath
    )
  ]);
  if (!payloadDirectories.has(pointers.activePayloadKey)) {
    addConversationActivePayloadMissing(
      accumulator,
      `${sessionId}:${pointers.activePayloadKey}`
    );
    return { messageRows: [], snapshotRows: [] };
  }
  if (
    pointers.previousPayloadKey
    && !payloadDirectories.has(pointers.previousPayloadKey)
  ) {
    accumulator.missingCount += 1;
    accumulator.addFinding({
      code: "conversation-previous-payload-missing",
      category: "missing",
      severity: "warning",
      recordRaw: `${sessionId}:${pointers.previousPayloadKey}`,
      blocksMigration: false
    });
  }

  const activeRoot = path.join(
    sessionDir,
    "context-payloads",
    pointers.activePayloadKey
  );
  const [messageRows, snapshotRows] = await Promise.all([
    readRequiredConversationJsonl(
      context,
      accumulator,
      path.join(activeRoot, "messages.jsonl"),
      "conversation-messages-corrupt",
      `${sessionId}:${pointers.activePayloadKey}:messages`
    ),
    readRequiredConversationJsonl(
      context,
      accumulator,
      path.join(activeRoot, "snapshots.jsonl"),
      "conversation-snapshots-corrupt",
      `${sessionId}:${pointers.activePayloadKey}:snapshots`
    )
  ]);
  if (
    pointers.payloadVersion === 2
    && (
      !pointers.activePayloadCommitId
      || createConversationPayloadKeyV2(
        pointers.activePayloadCommitId,
        messageRows,
        snapshotRows
      ) !== pointers.activePayloadKey
    )
  ) {
    accumulator.addCorrupt(
      "conversation-payload-pointer-invalid",
      `${sessionId}:${pointers.activePayloadKey}`
    );
  }
  return { messageRows, snapshotRows };
}

async function scanConversationPayloadMetadata(
  context: ScanContext,
  accumulator: SourceAccumulator,
  sessionDir: string,
  activePayloadKey?: string,
  previousPayloadKey?: string
): Promise<Set<string>> {
  const payloadRoot = path.join(sessionDir, "context-payloads");
  const entries = await listDirectory(
    context,
    accumulator,
    payloadRoot,
    true
  ) ?? [];
  const validDirectories = new Set<string>();
  const referenced = new Set(
    [activePayloadKey, previousPayloadKey].filter(
      (value): value is string => Boolean(value)
    )
  );
  for (const name of entries.sort()) {
    const target = path.join(payloadRoot, name);
    const stats = await safeLstat(context, accumulator, target, false);
    if (!stats) continue;
    if (!stats.isDirectory() || !isConversationPayloadKey(name)) {
      accumulator.addFinding({
        code: "conversation-payload-unreferenced",
        category: "unlinked",
        severity: "warning",
        recordRaw: target,
        blocksMigration: false
      });
      if (stats.isFile()) accumulator.addFile(target, stats);
      continue;
    }
    validDirectories.add(name);
    accumulator.incrementMetric("metadata-entry-count");
    if (!referenced.has(name)) {
      accumulator.addFinding({
        code: "conversation-payload-unreferenced",
        category: "unlinked",
        severity: "warning",
        recordRaw: target,
        blocksMigration: false
      });
    }
    const children = await listDirectory(
      context,
      accumulator,
      target,
      true
    ) ?? [];
    for (const child of children.sort()) {
      const childPath = path.join(target, child);
      const childStats = await safeLstat(
        context,
        accumulator,
        childPath,
        false
      );
      if (!childStats?.isFile()) continue;
      const activeBody = name === activePayloadKey
        && (child === "messages.jsonl" || child === "snapshots.jsonl");
      if (!activeBody) accumulator.addFile(childPath, childStats);
      accumulator.incrementMetric("metadata-entry-count");
    }
  }
  return validDirectories;
}

async function observeMetadataOnlyFile(
  context: ScanContext,
  accumulator: SourceAccumulator,
  filePath: string
): Promise<void> {
  const stats = await safeLstat(context, accumulator, filePath, true);
  if (stats?.isFile()) {
    accumulator.addFile(filePath, stats);
    accumulator.incrementMetric("metadata-entry-count");
  }
}

async function readRequiredConversationJsonl(
  context: ScanContext,
  accumulator: SourceAccumulator,
  filePath: string,
  corruptCode: string,
  missingRecordRaw: string
): Promise<unknown[]> {
  const stats = await safeLstat(context, accumulator, filePath, false);
  if (!stats) {
    addConversationActivePayloadMissing(accumulator, missingRecordRaw);
    return [];
  }
  if (!stats.isFile()) {
    accumulator.addCorrupt("expected-file", filePath);
    addConversationActivePayloadMissing(accumulator, missingRecordRaw);
    return [];
  }
  accumulator.addFile(filePath, stats);
  let text: string;
  try {
    text = await context.fs.readFile(filePath, "utf8");
  } catch {
    accumulator.addCorrupt("file-read-failed", filePath);
    return [];
  }
  const rows: unknown[] = [];
  let corruptLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch {
      corruptLines += 1;
    }
  }
  if (corruptLines) {
    accumulator.corruptCount += corruptLines;
    accumulator.markPartial(corruptCode);
    accumulator.addFinding({
      code: "corrupt-jsonl",
      category: "corrupt",
      severity: "blocking",
      recordRaw: filePath,
      count: corruptLines,
      blocksMigration: true
    });
  }
  return rows;
}

function addConversationActivePayloadMissing(
  accumulator: SourceAccumulator,
  recordRaw: string
): void {
  accumulator.missingCount += 1;
  accumulator.markPartial("conversation-active-payload-missing");
  accumulator.addFinding({
    code: "conversation-active-payload-missing",
    category: "missing",
    severity: "blocking",
    recordRaw,
    blocksMigration: true
  });
}

function isConversationPayloadKey(value: string): boolean {
  return /^payload-[a-f0-9]{64}$/.test(value);
}

function conversationPayloadKey(commitId: string): string {
  return `payload-${createHash("sha256")
    .update(commitId)
    .digest("hex")}`;
}

function recordMutationToken(mutationId: string): string {
  return `mutation-${createHash("sha256")
    .update(Buffer.from(mutationId, "utf8"))
    .digest("hex")
    .slice(0, 24)}`;
}

async function scanHistory(
  context: ScanContext
): Promise<SourceScan<HistoryFacts>> {
  const probe = new SourceAccumulator("history", context.pluginRoot);
  const facts: HistoryFacts = {
    sessions: new Map(),
    references: [],
    rawReferences: []
  };
  const root = path.join(context.pluginRoot, "history");
  const rootStats = await safeLstat(context, probe, root, true);
  if (!rootStats) {
    probe.markUnavailable("history-store-unavailable");
    probe.missingCount += 1;
    return { accumulator: probe, facts };
  }
  if (!rootStats.isDirectory()) {
    probe.addCorrupt("expected-directory", root);
    return { accumulator: probe, facts };
  }
  const activePath = path.join(root, "v2", "active.json");
  const activeStats = await safeLstat(
    context,
    probe,
    activePath,
    true
  );
  return activeStats
    ? await scanHistoryV2(context)
    : await scanLegacyHistoryV1(context);
}

async function scanHistoryV2(
  context: ScanContext
): Promise<SourceScan<HistoryFacts>> {
  const accumulator = new SourceAccumulator("history", context.pluginRoot);
  const facts: HistoryFacts = {
    sessions: new Map(),
    references: [],
    rawReferences: []
  };
  accumulator.schemaVersion = String(CURRENT_HISTORY_SCHEMA);
  const root = path.join(context.pluginRoot, "history", "v2");
  const rootEntries = await listDirectory(
    context,
    accumulator,
    root,
    false
  );
  if (!rootEntries) {
    accumulator.markUnavailable("history-v2-store-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  const activePath = path.join(root, "active.json");
  const activeRead = await readTextFile(
    context,
    accumulator,
    activePath,
    false
  );
  const active = activeRead
    ? parseJsonObject(
      activeRead.text,
      accumulator,
      "history-active-corrupt",
      activePath
    )
    : null;
  if (!active) {
    accumulator.missingCount += 1;
    accumulator.markPartial("history-active-missing");
    return { accumulator, facts };
  }
  if (!hasExactKeys(active, [
    "version",
    "kind",
    "generationId",
    "generationRevision",
    "sourceRevision",
    "suppressionRevision",
    "publishedAt"
  ])) {
    accumulator.addCorrupt("history-active-schema-invalid", "active");
    return { accumulator, facts };
  }
  const activeVersion = finiteInteger(active.version);
  if (activeVersion !== CURRENT_HISTORY_SCHEMA) {
    if (
      activeVersion !== null
      && activeVersion > CURRENT_HISTORY_SCHEMA
    ) {
      accumulator.futureSchemaCount += 1;
      accumulator.addFinding({
        code: "future-schema",
        category: "future-schema",
        severity: "blocking",
        recordRaw: "active",
        blocksMigration: true
      });
    } else {
      accumulator.addCorrupt("history-active-schema-invalid", "active");
    }
    accumulator.markPartial("history-active-schema-invalid");
    return { accumulator, facts };
  }
  const generationId = nonEmptyStringOrNull(active.generationId);
  const generationRevision = sha256RevisionOrNull(
    active.generationRevision
  );
  const sourceRevision = sha256RevisionOrNull(active.sourceRevision);
  const suppressionRevision = sha256RevisionOrNull(
    active.suppressionRevision
  );
  if (
    active.kind !== "knowledge-history-active"
    || !generationId
    || !safePathSegment(generationId)
    || !generationRevision
    || !sourceRevision
    || !suppressionRevision
    || finiteTimestamp(active.publishedAt) === null
  ) {
    accumulator.addCorrupt("history-active-schema-invalid", "active");
    return { accumulator, facts };
  }
  facts.activeSourceRevision = sourceRevision;
  facts.activeGenerationId = generationId;
  accumulator.observeRecordMetadata("history-active", {
    version: activeVersion,
    kind: active.kind,
    generationId,
    generationRevision,
    sourceRevision,
    suppressionRevision,
    publishedAt: finiteTimestamp(active.publishedAt)
  });

  const generationRoot = path.join(
    root,
    "generations",
    generationId
  );
  const generationEntries = await listDirectory(
    context,
    accumulator,
    generationRoot,
    false
  );
  if (!generationEntries) {
    accumulator.missingCount += 1;
    accumulator.addFinding({
      code: "history-generation-missing",
      category: "missing",
      severity: "blocking",
      recordRaw: generationId,
      blocksMigration: true
    });
    return { accumulator, facts };
  }
  const manifestPath = path.join(generationRoot, "manifest.json");
  const indexPath = path.join(generationRoot, "index.json");
  const suppressionsPath = path.join(
    generationRoot,
    "suppressions.json"
  );
  const [manifestRead, indexRead, suppressionsRead] = await Promise.all([
    readTextFile(context, accumulator, manifestPath, false),
    readTextFile(context, accumulator, indexPath, false),
    readTextFile(context, accumulator, suppressionsPath, false)
  ]);
  const manifest = manifestRead
    ? parseJsonObject(
      manifestRead.text,
      accumulator,
      "history-generation-corrupt",
      manifestPath
    )
    : null;
  const index = indexRead
    ? parseJsonObject(
      indexRead.text,
      accumulator,
      "history-index-corrupt",
      indexPath
    )
    : null;
  const suppressions = suppressionsRead
    ? parseJsonObject(
      suppressionsRead.text,
      accumulator,
      "history-suppressions-corrupt",
      suppressionsPath
    )
    : null;
  if (!manifest || !index || !suppressions) {
    accumulator.markPartial("history-generation-incomplete");
    return { accumulator, facts };
  }
  if (!validateHistoryGenerationManifest(
    manifest,
    generationId,
    accumulator
  )) {
    return { accumulator, facts };
  }
  if (!validateHistorySuppressions(
    suppressions,
    suppressionRevision,
    accumulator,
    "generation"
  )) {
    return { accumulator, facts };
  }
  if (
    stableInventoryRevision(manifest) !== generationRevision
    || sha256RevisionOrNull(manifest.sourceRevision)
      !== sourceRevision
    || sha256RevisionOrNull(manifest.suppressionRevision)
      !== suppressionRevision
    || stableInventoryRevision(index)
      !== sha256RevisionOrNull(manifest.indexRevision)
  ) {
    accumulator.addCorrupt(
      "history-generation-revision-mismatch",
      generationId
    );
    return { accumulator, facts };
  }

  const descriptors = parseHistoryGenerationFiles(
    manifest.files,
    accumulator,
    generationId
  );
  if (!descriptors) return { accumulator, facts };
  const expectedProjectionRevision = stableInventoryRevision({
    indexRevision: manifest.indexRevision,
    suppressionRevision: manifest.suppressionRevision,
    files: descriptors
  });
  if (
    expectedProjectionRevision
    !== sha256RevisionOrNull(manifest.projectionRevision)
  ) {
    accumulator.addCorrupt(
      "history-generation-revision-mismatch",
      `${generationId}:projection`
    );
    return { accumulator, facts };
  }
  const actualPaths = await listHistoryV2DayPaths(
    context,
    accumulator,
    generationRoot
  );
  const declaredPaths = descriptors.map(
    (descriptor) => descriptor.relativePath
  );
  if (
    stableCanonicalJson(actualPaths)
    !== stableCanonicalJson(declaredPaths)
  ) {
    accumulator.addCorrupt(
      "history-generation-file-set-mismatch",
      generationId
    );
  }

  const referencesBySessionDate = new Map<
    string,
    HistoryReferenceFact[]
  >();
  const globalReferences = new Set<string>();
  for (const descriptor of descriptors) {
    const target = path.join(generationRoot, descriptor.relativePath);
    if (!isWithin(generationRoot, target)) {
      accumulator.addCorrupt(
        "history-generation-path-invalid",
        descriptor.relativePath
      );
      continue;
    }
    const read = await readTextFile(
      context,
      accumulator,
      target,
      false
    );
    if (!read) continue;
    if (sha256TextRevision(read.text) !== descriptor.digest) {
      accumulator.addCorrupt(
        "history-generation-file-digest-mismatch",
        descriptor.relativePath
      );
      continue;
    }
    const identity = historyV2DayIdentity(descriptor.relativePath);
    if (!identity) {
      accumulator.addCorrupt(
        "history-generation-path-invalid",
        descriptor.relativePath
      );
      continue;
    }
    const rows = parseHistoryV2ReferenceRows(
      read.text,
      accumulator,
      descriptor.relativePath
    );
    if (rows.length !== descriptor.rowCount) {
      accumulator.addCorrupt(
        "history-generation-row-count-mismatch",
        descriptor.relativePath
      );
    }
    for (const reference of rows) {
      if (
        sanitizeHistoryPathPart(reference.conversationId)
        !== identity.sessionDirectory
      ) {
        accumulator.addCorrupt(
          "history-reference-conversation-mismatch",
          `${descriptor.relativePath}:${reference.messageId}`
        );
      }
      const duplicateKey =
        `${reference.conversationId}\0${reference.messageId}`;
      if (globalReferences.has(duplicateKey)) {
        accumulator.addCorrupt(
          "history-reference-duplicate",
          `${reference.conversationId}:${reference.messageId}`
        );
      }
      globalReferences.add(duplicateKey);
      const fact: HistoryReferenceFact = {
        ...reference,
        date: identity.date,
        ownerRef: opaque(
          "history-message",
          `${reference.conversationId}:${identity.date}:${reference.messageId}`
        )
      };
      facts.references.push(fact);
      const bucketKey =
        `${reference.conversationId}\0${identity.date}`;
      const bucket = referencesBySessionDate.get(bucketKey) ?? [];
      bucket.push(fact);
      referencesBySessionDate.set(bucketKey, bucket);
    }
  }

  const indexSessions = validateHistoryV2Index(
    index,
    referencesBySessionDate,
    facts,
    accumulator
  );
  if (indexSessions !== null) {
    const manifestSessionCount = finiteInteger(manifest.sessionCount);
    const manifestDayCount = finiteInteger(manifest.dayCount);
    const manifestMessageCount = finiteInteger(manifest.messageCount);
    const actualDayCount = indexSessions.reduce(
      (sum, session) => sum + session.dayCount,
      0
    );
    const actualMessageCount = indexSessions.reduce(
      (sum, session) => sum + session.messageCount,
      0
    );
    if (
      manifestSessionCount !== indexSessions.length
      || manifestDayCount !== actualDayCount
      || manifestMessageCount !== actualMessageCount
      || descriptors.length !== actualDayCount
      || descriptors.reduce(
        (sum, descriptor) => sum + descriptor.rowCount,
        0
      ) !== actualMessageCount
    ) {
      accumulator.addCorrupt(
        "history-generation-count-mismatch",
        generationId
      );
    }
  }

  const rootSuppressionsPath = path.join(root, "suppressions.json");
  const rootSuppressionsRead = await readTextFile(
    context,
    accumulator,
    rootSuppressionsPath,
    true
  );
  if (
    !rootSuppressionsRead
    || !validateHistorySuppressions(
      parseJsonObject(
        rootSuppressionsRead.text,
        accumulator,
        "history-suppressions-corrupt",
        rootSuppressionsPath
      ),
      suppressionRevision,
      accumulator,
      "root"
    )
  ) {
    accumulator.addFinding({
      code: "history-suppression-projection-drift",
      category: "ambiguous",
      severity: "warning",
      recordRaw: generationId,
      blocksMigration: false
    });
  }

  accumulator.observeRecordMetadata("history-generation", {
    generationId,
    sourceRevision,
    suppressionRevision,
    retentionDays: finiteInteger(manifest.retentionDays),
    retentionCutoffDate: stringOrNull(manifest.retentionCutoffDate),
    sessionCount: finiteInteger(manifest.sessionCount),
    dayCount: finiteInteger(manifest.dayCount),
    messageCount: finiteInteger(manifest.messageCount)
  });
  accumulator.recordCount = facts.sessions.size;
  accumulator.incrementMetric("session-count", facts.sessions.size);
  accumulator.incrementMetric(
    "day-count",
    facts.sessions.size
      ? [...facts.sessions.values()].reduce(
        (sum, session) =>
          sum + new Set(
            facts.references
              .filter(
                (reference) =>
                  reference.conversationId === session.id
              )
              .map((reference) => reference.date)
          ).size,
        0
      )
      : 0
  );
  accumulator.incrementMetric(
    "message-count",
    facts.references.length
  );
  accumulator.incrementMetric("raw-reference-count", 0);
  return { accumulator, facts };
}

async function scanLegacyHistoryV1(
  context: ScanContext
): Promise<SourceScan<HistoryFacts>> {
  const accumulator = new SourceAccumulator("history", context.pluginRoot);
  const facts: HistoryFacts = {
    sessions: new Map(),
    references: [],
    rawReferences: []
  };
  const root = path.join(context.pluginRoot, "history");
  const rootEntries = await listDirectory(context, accumulator, root, false);
  if (!rootEntries) {
    accumulator.markUnavailable("history-store-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  const indexPath = path.join(root, "index.json");
  const indexRead = await readTextFile(context, accumulator, indexPath, false);
  let indexSessions: Array<Record<string, unknown>> = [];
  if (indexRead) {
    const index = parseJsonObject(indexRead.text, accumulator, "history-index-corrupt", indexPath);
    if (index) {
      const version = finiteInteger(index.version);
      accumulator.schemaVersion = version === null ? null : String(version);
      accumulator.observeRecordMetadata("history-index", {
        version,
        updatedAt: finiteTimestamp(index.updatedAt)
      });
      if (version !== null && version > CURRENT_HISTORY_SCHEMA) {
        accumulator.futureSchemaCount += 1;
        accumulator.markPartial("future-schema");
        accumulator.addFinding({
          code: "future-schema",
          category: "future-schema",
          severity: "blocking",
          recordRaw: "index",
          blocksMigration: true
        });
      }
      if (Array.isArray(index.sessions)) {
        index.sessions.forEach((value, indexPosition) => {
          const session = objectRecord(value);
          if (!session) {
            accumulator.addCorrupt(
              "history-index-entry-invalid",
              `index-entry:${indexPosition}`
            );
            return;
          }
          indexSessions.push(session);
        });
      } else {
        accumulator.addCorrupt("history-index-invalid", "index");
      }
    }
  } else {
    accumulator.missingCount += 1;
    accumulator.markPartial("history-index-missing");
    accumulator.addFinding({
      code: "history-index-drift",
      category: "missing",
      severity: "blocking",
      recordRaw: "index",
      blocksMigration: true
    });
  }

  const sessionsRoot = path.join(root, "sessions");
  const sessionDirs = await listDirectory(context, accumulator, sessionsRoot, false) ?? [];
  const actualDays = new Map<string, Map<string, MessageFact[]>>();
  const globalMessageOwners = new Map<string, string[]>();
  for (const directoryName of sessionDirs.sort()) {
    const sessionDir = path.join(sessionsRoot, directoryName);
    const sessionStats = await safeLstat(context, accumulator, sessionDir, false);
    if (!sessionStats || !sessionStats.isDirectory()) continue;
    const files = await listDirectory(context, accumulator, sessionDir, false) ?? [];
    const dayMap = new Map<string, MessageFact[]>();
    for (const fileName of files.filter((name) => name.endsWith(".jsonl")).sort()) {
      const date = fileName.slice(0, -".jsonl".length);
      const filePath = path.join(sessionDir, fileName);
      const rows = await readJsonlFile(
        context,
        accumulator,
        filePath,
        "history-day-corrupt",
        false
      );
      const messages = collectMessageFacts(
        rows,
        accumulator,
        "history",
        `day:${directoryName}:${date}`
      );
      dayMap.set(date, messages);
      for (const message of messages) {
        accumulator.addTimestamp(message.createdAt);
        const owner = `${directoryName}:${date}`;
        const owners = globalMessageOwners.get(message.id) ?? [];
        owners.push(owner);
        globalMessageOwners.set(message.id, owners);
      }
    }
    actualDays.set(directoryName, dayMap);
    const allMessages = [...dayMap.values()].flat();
    const indexed = indexSessions.find((entry) =>
      typeof entry.sessionId === "string"
      && sanitizeHistoryPathPart(entry.sessionId) === directoryName);
    const sessionId = typeof indexed?.sessionId === "string"
      ? indexed.sessionId
      : directoryName;
    for (const [date, messages] of dayMap) {
      for (const message of messages) {
        facts.references.push({
          conversationId: sessionId,
          messageId: message.id,
          messageRevision: message.revision,
          date,
          ownerRef: opaque(
            "history-message",
            `${sessionId}:${date}:${message.id}`
          ),
          ...(message.runId ? { runId: message.runId } : {})
        });
      }
    }
    facts.sessions.set(sessionId, {
      id: sessionId,
      messageIds: new Set(allMessages.map((message) => message.id)),
      messages: messageFactMap(allMessages),
      messageOrder: allMessages.map((message) => message.id),
      duplicateMessageIds: duplicateMessageFactIds(allMessages),
      messageCount: allMessages.length,
      rawReferences: [],
      createdAt: minimumPositive(allMessages.map((message) => message.createdAt)),
      updatedAt: maximumPositive(allMessages.map((message) => message.createdAt))
    });
    accumulator.incrementMetric("day-count", dayMap.size);
    accumulator.incrementMetric("message-count", allMessages.length);
  }

  const indexedDirectoryNames = new Set<string>();
  for (const session of indexSessions) {
    if (typeof session.sessionId !== "string" || !session.sessionId) {
      accumulator.addCorrupt("history-index-entry-invalid", "index-entry");
      continue;
    }
    accumulator.observeRecordMetadata("history-index-session", {
      sessionId: session.sessionId,
      kind: stringOrNull(session.kind),
      activeDate: stringOrNull(session.activeDate),
      messageCount: finiteInteger(session.messageCount),
      dayCount: finiteInteger(session.dayCount),
      updatedAt: finiteTimestamp(session.updatedAt)
    });
    const directoryName = sanitizeHistoryPathPart(session.sessionId);
    if (indexedDirectoryNames.has(directoryName)) {
      accumulator.addCorrupt("history-index-duplicate-id", session.sessionId);
      continue;
    }
    indexedDirectoryNames.add(directoryName);
    const days = actualDays.get(directoryName);
    if (!days) {
      accumulator.missingCount += 1;
      accumulator.addFinding({
        code: "history-index-drift",
        category: "missing",
        severity: "blocking",
        recordRaw: session.sessionId,
        blocksMigration: true
      });
      continue;
    }
    const indexedDays = Array.isArray(session.days)
      ? session.days.map(objectRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const indexedDates = new Set<string>();
    let indexedTotal = 0;
    for (const day of indexedDays) {
      if (typeof day.date !== "string" || !day.date) {
        accumulator.addCorrupt("history-day-index-invalid", session.sessionId);
        continue;
      }
      accumulator.observeRecordMetadata("history-index-day", {
        sessionId: session.sessionId,
        date: day.date,
        messageCount: finiteInteger(day.messageCount),
        userMessageCount: finiteInteger(day.userMessageCount),
        assistantMessageCount: finiteInteger(day.assistantMessageCount),
        processMessageCount: finiteInteger(day.processMessageCount),
        failedMessageCount: finiteInteger(day.failedMessageCount),
        firstMessageAt: finiteTimestamp(day.firstMessageAt),
        lastMessageAt: finiteTimestamp(day.lastMessageAt)
      });
      if (indexedDates.has(day.date)) {
        accumulator.addCorrupt(
          "history-day-index-duplicate",
          `${session.sessionId}:${day.date}`
        );
        continue;
      }
      indexedDates.add(day.date);
      const actual = days.get(day.date);
      const indexedCount = finiteInteger(day.messageCount) ?? 0;
      indexedTotal += indexedCount;
      if (!actual) {
        accumulator.missingCount += 1;
        accumulator.addFinding({
          code: "history-day-index-drift",
          category: "missing",
          severity: "blocking",
          recordRaw: `${session.sessionId}:${day.date}`,
          blocksMigration: true
        });
      } else if (indexedCount !== actual.length) {
        accumulator.addFinding({
          code: "history-day-count-drift",
          category: "ambiguous",
          severity: "warning",
          recordRaw: `${session.sessionId}:${day.date}`,
          metadata: [
            { name: "indexed-count", value: indexedCount },
            { name: "actual-count", value: actual.length }
          ],
          blocksMigration: false
        });
      }
    }
    for (const date of days.keys()) {
      if (indexedDates.has(date)) continue;
      accumulator.addFinding({
        code: "history-day-unindexed",
        category: "unlinked",
        severity: "warning",
        recordRaw: `${session.sessionId}:${date}`,
        blocksMigration: false
      });
    }
    const indexedSessionCount = finiteInteger(session.messageCount);
    const actualSessionCount = [...days.values()].reduce((sum, messages) => sum + messages.length, 0);
    if (indexedSessionCount !== null && indexedSessionCount !== actualSessionCount) {
      accumulator.addFinding({
        code: "history-index-count-drift",
        category: "ambiguous",
        severity: "warning",
        recordRaw: session.sessionId,
        metadata: [
          { name: "indexed-count", value: indexedSessionCount },
          { name: "actual-count", value: actualSessionCount },
          { name: "indexed-day-sum", value: indexedTotal }
        ],
        blocksMigration: false
      });
    }
  }
  for (const directoryName of actualDays.keys()) {
    if (indexedDirectoryNames.has(directoryName)) continue;
    accumulator.addFinding({
      code: "history-session-unindexed",
      category: "unlinked",
      severity: "warning",
      recordRaw: directoryName,
      blocksMigration: false
    });
  }
  for (const [messageId, owners] of globalMessageOwners) {
    if (owners.length < 2) continue;
    accumulator.addFinding({
      code: "duplicate-message-id",
      category: "ambiguous",
      severity: "warning",
      recordRaw: messageId,
      count: owners.length,
      blocksMigration: false
    });
  }
  accumulator.recordCount = facts.sessions.size;
  accumulator.incrementMetric("session-count", facts.sessions.size);
  accumulator.incrementMetric("raw-reference-count", 0);
  accumulator.markPartial("history-schema-migration-required");
  accumulator.addFinding({
    code: "history-schema-migration-required",
    category: "unlinked",
    severity: "blocking",
    recordRaw: "v1",
    blocksMigration: true
  });
  return { accumulator, facts };
}

function validateHistoryGenerationManifest(
  manifest: Record<string, unknown>,
  generationId: string,
  accumulator: SourceAccumulator
): boolean {
  if (!hasExactKeys(manifest, [
    "version",
    "kind",
    "generationId",
    "createdAt",
    "sourceRevision",
    "suppressionRevision",
    "retentionDays",
    "retentionCutoffDate",
    "indexRevision",
    "projectionRevision",
    "sessionCount",
    "dayCount",
    "messageCount",
    "files"
  ])) {
    accumulator.addCorrupt(
      "history-generation-schema-invalid",
      generationId
    );
    return false;
  }
  const version = finiteInteger(manifest.version);
  if (version !== CURRENT_HISTORY_SCHEMA) {
    if (version !== null && version > CURRENT_HISTORY_SCHEMA) {
      accumulator.futureSchemaCount += 1;
      accumulator.addFinding({
        code: "future-schema",
        category: "future-schema",
        severity: "blocking",
        recordRaw: generationId,
        blocksMigration: true
      });
    } else {
      accumulator.addCorrupt(
        "history-generation-schema-invalid",
        generationId
      );
    }
    return false;
  }
  const retentionDays = manifest.retentionDays;
  const retentionCutoffDate = manifest.retentionCutoffDate;
  const validRetention = (
    retentionDays === null
    && retentionCutoffDate === null
  ) || (
    finiteInteger(retentionDays) !== null
    && (finiteInteger(retentionDays) ?? 0) > 0
    && typeof retentionCutoffDate === "string"
    && isHistoryDateKey(retentionCutoffDate)
  );
  if (
    manifest.kind !== "knowledge-history-generation"
    || manifest.generationId !== generationId
    || finiteTimestamp(manifest.createdAt) === null
    || !sha256RevisionOrNull(manifest.sourceRevision)
    || !sha256RevisionOrNull(manifest.suppressionRevision)
    || !sha256RevisionOrNull(manifest.indexRevision)
    || !sha256RevisionOrNull(manifest.projectionRevision)
    || !validRetention
    || finiteInteger(manifest.sessionCount) === null
    || finiteInteger(manifest.dayCount) === null
    || finiteInteger(manifest.messageCount) === null
    || !Array.isArray(manifest.files)
  ) {
    accumulator.addCorrupt(
      "history-generation-schema-invalid",
      generationId
    );
    return false;
  }
  return true;
}

function validateHistorySuppressions(
  value: Record<string, unknown> | null,
  expectedRevision: string,
  accumulator: SourceAccumulator,
  owner: string
): boolean {
  if (
    !value
    || !hasExactKeys(value, [
      "version",
      "kind",
      "revision",
      "updatedAt",
      "entries"
    ])
    || finiteInteger(value.version) !== CURRENT_HISTORY_SCHEMA
    || value.kind !== "knowledge-history-suppressions"
    || !sha256RevisionOrNull(value.revision)
    || finiteTimestamp(value.updatedAt) === null
    || !Array.isArray(value.entries)
  ) {
    accumulator.addCorrupt(
      "history-suppressions-schema-invalid",
      owner
    );
    return false;
  }
  const seen = new Set<string>();
  let valid = true;
  for (const [index, entryValue] of value.entries.entries()) {
    const entry = objectRecord(entryValue);
    if (
      !entry
      || !hasExactKeys(entry, [
        "version",
        "conversationId",
        "messageId",
        "messageRevision",
        "date",
        "suppressedAt",
        "reason"
      ])
      || finiteInteger(entry.version) !== CURRENT_HISTORY_SCHEMA
      || !isNonEmptyString(entry.conversationId)
      || !isNonEmptyString(entry.messageId)
      || !sha256RevisionOrNull(entry.messageRevision)
      || typeof entry.date !== "string"
      || !isHistoryDateKey(entry.date)
      || finiteTimestamp(entry.suppressedAt) === null
      || entry.reason !== "user-delete"
    ) {
      accumulator.addCorrupt(
        "history-suppression-invalid",
        `${owner}:${index}`
      );
      valid = false;
      continue;
    }
    const key = `${entry.conversationId}\0${entry.messageId}`;
    if (seen.has(key)) {
      accumulator.addCorrupt(
        "history-suppression-duplicate",
        `${owner}:${entry.conversationId}:${entry.messageId}`
      );
      valid = false;
    }
    seen.add(key);
  }
  const revision = stableInventoryRevision({
    version: CURRENT_HISTORY_SCHEMA,
    kind: "knowledge-history-suppressions",
    entries: value.entries
  });
  if (
    revision !== value.revision
    || revision !== expectedRevision
  ) {
    accumulator.addCorrupt(
      "history-suppression-revision-mismatch",
      owner
    );
    return false;
  }
  accumulator.observeRecordMetadata("history-suppressions", {
    owner,
    revision,
    entryCount: value.entries.length,
    updatedAt: finiteTimestamp(value.updatedAt)
  });
  return valid;
}

function parseHistoryGenerationFiles(
  value: unknown,
  accumulator: SourceAccumulator,
  generationId: string
): HistoryGenerationFileFact[] | null {
  if (!Array.isArray(value)) {
    accumulator.addCorrupt(
      "history-generation-files-invalid",
      generationId
    );
    return null;
  }
  const files: HistoryGenerationFileFact[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const [index, item] of value.entries()) {
    const record = objectRecord(item);
    const relativePath =
      typeof record?.relativePath === "string"
        ? record.relativePath
        : "";
    const digest = sha256RevisionOrNull(record?.digest);
    const rowCount = finiteInteger(record?.rowCount);
    if (
      !record
      || !hasExactKeys(record, [
        "relativePath",
        "digest",
        "rowCount"
      ])
      || !historyV2DayIdentity(relativePath)
      || !digest
      || rowCount === null
      || rowCount < 0
      || seen.has(relativePath)
      || (previous && relativePath.localeCompare(previous) < 0)
    ) {
      accumulator.addCorrupt(
        "history-generation-file-invalid",
        `${generationId}:${index}`
      );
      return null;
    }
    seen.add(relativePath);
    previous = relativePath;
    files.push({ relativePath, digest, rowCount });
  }
  return files;
}

async function listHistoryV2DayPaths(
  context: ScanContext,
  accumulator: SourceAccumulator,
  generationRoot: string
): Promise<string[]> {
  const sessionsRoot = path.join(generationRoot, "sessions");
  const sessionDirectories = await listDirectory(
    context,
    accumulator,
    sessionsRoot,
    true
  ) ?? [];
  const paths: string[] = [];
  for (const sessionDirectory of sessionDirectories.sort()) {
    const sessionRoot = path.join(sessionsRoot, sessionDirectory);
    const stats = await safeLstat(
      context,
      accumulator,
      sessionRoot,
      false
    );
    if (!stats?.isDirectory()) {
      accumulator.addCorrupt(
        "history-generation-path-invalid",
        sessionDirectory
      );
      continue;
    }
    const dayFiles = await listDirectory(
      context,
      accumulator,
      sessionRoot,
      false
    ) ?? [];
    for (const dayFile of dayFiles.sort()) {
      const relativePath = path.posix.join(
        "sessions",
        sessionDirectory,
        dayFile
      );
      if (!historyV2DayIdentity(relativePath)) {
        accumulator.addCorrupt(
          "history-generation-path-invalid",
          relativePath
        );
        continue;
      }
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

function historyV2DayIdentity(
  relativePath: string
): { sessionDirectory: string; date: string } | null {
  if (
    !relativePath
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    return null;
  }
  const parts = relativePath.split("/");
  if (
    parts.length !== 3
    || parts[0] !== "sessions"
    || !safePathSegment(parts[1] ?? "")
    || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(parts[2] ?? "")
  ) {
    return null;
  }
  const date = (parts[2] ?? "").slice(0, -".jsonl".length);
  return isHistoryDateKey(date)
    ? { sessionDirectory: parts[1], date }
    : null;
}

function parseHistoryV2ReferenceRows(
  text: string,
  accumulator: SourceAccumulator,
  owner: string
): HistoryReferenceRowV2[] {
  const rows: HistoryReferenceRowV2[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      accumulator.addCorrupt(
        "history-reference-invalid",
        `${owner}:${index + 1}`
      );
      continue;
    }
    const record = objectRecord(value);
    if (
      !record
      || !hasExactKeys(record, [
        "version",
        "kind",
        "conversationId",
        "messageId",
        "messageRevision"
      ])
      || finiteInteger(record.version) !== CURRENT_HISTORY_SCHEMA
      || record.kind !== "conversation-message"
      || !isNonEmptyString(record.conversationId)
      || !isNonEmptyString(record.messageId)
      || !sha256RevisionOrNull(record.messageRevision)
    ) {
      accumulator.addCorrupt(
        "history-reference-invalid",
        `${owner}:${index + 1}`
      );
      continue;
    }
    rows.push({
      conversationId: record.conversationId,
      messageId: record.messageId,
      messageRevision: sha256RevisionOrNull(record.messageRevision)!
    });
  }
  return rows;
}

function validateHistoryV2Index(
  index: Record<string, unknown>,
  referencesBySessionDate: ReadonlyMap<
    string,
    HistoryReferenceFact[]
  >,
  facts: HistoryFacts,
  accumulator: SourceAccumulator
): Array<{ messageCount: number; dayCount: number }> | null {
  if (
    !hasExactKeys(index, ["version", "updatedAt", "sessions"])
    || finiteInteger(index.version) !== CURRENT_HISTORY_SCHEMA
    || finiteTimestamp(index.updatedAt) === null
    || !Array.isArray(index.sessions)
  ) {
    accumulator.addCorrupt("history-index-invalid", "v2-index");
    return null;
  }
  const indexedBuckets = new Set<string>();
  const sessionCounts: Array<{
    messageCount: number;
    dayCount: number;
  }> = [];
  const sessionIds = new Set<string>();
  for (const [sessionPosition, sessionValue] of index.sessions.entries()) {
    const session = objectRecord(sessionValue);
    if (
      !session
      || !hasExactKeys(session, [
        "sessionId",
        "title",
        "kind",
        "activeDate",
        "messageCount",
        "dayCount",
        "updatedAt",
        "days"
      ])
      || !isNonEmptyString(session.sessionId)
      || !isNonEmptyString(session.title)
      || session.kind !== "knowledge-base"
      || typeof session.activeDate !== "string"
      || (
        session.activeDate
        && !isHistoryDateKey(session.activeDate)
      )
      || finiteInteger(session.messageCount) === null
      || finiteInteger(session.dayCount) === null
      || finiteTimestamp(session.updatedAt) === null
      || !Array.isArray(session.days)
      || sessionIds.has(session.sessionId)
    ) {
      accumulator.addCorrupt(
        "history-index-entry-invalid",
        `v2-index:${sessionPosition}`
      );
      continue;
    }
    sessionIds.add(session.sessionId);
    const sessionReferences: HistoryReferenceFact[] = [];
    const indexedDates = new Set<string>();
    let dayMessageCount = 0;
    for (const [dayPosition, dayValue] of session.days.entries()) {
      const day = objectRecord(dayValue);
      if (
        !day
        || !hasExactKeys(day, [
          "date",
          "messageCount",
          "userMessageCount",
          "assistantMessageCount",
          "processMessageCount",
          "failedMessageCount",
          "firstMessageAt",
          "lastMessageAt"
        ])
        || typeof day.date !== "string"
        || !isHistoryDateKey(day.date)
        || indexedDates.has(day.date)
        || finiteInteger(day.messageCount) === null
        || finiteInteger(day.userMessageCount) === null
        || finiteInteger(day.assistantMessageCount) === null
        || finiteInteger(day.processMessageCount) === null
        || finiteInteger(day.failedMessageCount) === null
        || finiteTimestamp(day.firstMessageAt) === null
        || finiteTimestamp(day.lastMessageAt) === null
      ) {
        accumulator.addCorrupt(
          "history-day-index-invalid",
          `${session.sessionId}:${dayPosition}`
        );
        continue;
      }
      indexedDates.add(day.date);
      const bucketKey = `${session.sessionId}\0${day.date}`;
      indexedBuckets.add(bucketKey);
      const references = referencesBySessionDate.get(bucketKey) ?? [];
      if (finiteInteger(day.messageCount) !== references.length) {
        accumulator.addCorrupt(
          "history-day-count-drift",
          `${session.sessionId}:${day.date}`
        );
      }
      dayMessageCount += references.length;
      sessionReferences.push(...references);
      accumulator.addTimestamp(day.firstMessageAt);
      accumulator.addTimestamp(day.lastMessageAt);
      accumulator.observeRecordMetadata("history-index-day", {
        sessionId: session.sessionId,
        date: day.date,
        messageCount: finiteInteger(day.messageCount),
        userMessageCount: finiteInteger(day.userMessageCount),
        assistantMessageCount: finiteInteger(day.assistantMessageCount),
        processMessageCount: finiteInteger(day.processMessageCount),
        failedMessageCount: finiteInteger(day.failedMessageCount),
        firstMessageAt: finiteTimestamp(day.firstMessageAt),
        lastMessageAt: finiteTimestamp(day.lastMessageAt)
      });
    }
    if (
      finiteInteger(session.dayCount) !== session.days.length
      || finiteInteger(session.messageCount) !== dayMessageCount
    ) {
      accumulator.addCorrupt(
        "history-index-count-drift",
        session.sessionId
      );
    }
    const messageFacts: MessageFact[] = sessionReferences.map(
      (reference) => ({
        id: reference.messageId,
        createdAt: 0,
        revision: reference.messageRevision
      })
    );
    facts.sessions.set(session.sessionId, {
      id: session.sessionId,
      messageIds: new Set(
        sessionReferences.map((reference) => reference.messageId)
      ),
      messages: messageFactMap(messageFacts),
      messageOrder: messageFacts.map((message) => message.id),
      duplicateMessageIds: duplicateMessageFactIds(messageFacts),
      messageCount: sessionReferences.length,
      rawReferences: [],
      createdAt: minimumPositive(
        session.days
          .map(objectRecord)
          .map((day) => finiteTimestamp(day?.firstMessageAt) ?? 0)
      ),
      updatedAt: finiteTimestamp(session.updatedAt) ?? 0,
      title: session.title,
      kind: "knowledge-base",
      ...(session.activeDate
        ? { historyActiveDate: session.activeDate }
        : {})
    });
    sessionCounts.push({
      messageCount: sessionReferences.length,
      dayCount: session.days.length
    });
    accumulator.observeRecordMetadata("history-index-session", {
      sessionId: session.sessionId,
      title: session.title,
      activeDate: session.activeDate,
      messageCount: finiteInteger(session.messageCount),
      dayCount: finiteInteger(session.dayCount),
      updatedAt: finiteTimestamp(session.updatedAt)
    });
  }
  for (const key of referencesBySessionDate.keys()) {
    if (!indexedBuckets.has(key)) {
      accumulator.addCorrupt(
        "history-day-unindexed",
        key.replace("\0", ":")
      );
    }
  }
  return sessionCounts;
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sha256RevisionOrNull(value: unknown): string | null {
  return (
    typeof value === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value)
  ) ? value : null;
}

function sha256TextRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function stableInventoryRevision(value: unknown): string {
  return sha256TextRevision(stableCanonicalJson(value));
}

function isHistoryDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function scanHarnessRuns(context: ScanContext): Promise<SourceScan<RunFacts>> {
  const accumulator = new SourceAccumulator("harness-runs", context.pluginRoot);
  const facts: RunFacts = {
    runIds: new Set(),
    terminalRunIds: new Set(),
    locallyCommittedRunIds: new Set()
  };
  const root = path.join(context.pluginRoot, "harness-runs");
  const entries = await listDirectory(context, accumulator, root, false);
  if (!entries) {
    accumulator.markUnavailable("run-ledger-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  const runFileOwners = new Map<string, string>();
  const eventIdOwners = new Map<string, string>();
  for (const fileName of entries.filter((name) => name.endsWith(".jsonl")).sort()) {
    const filePath = path.join(root, fileName);
    const rows = await readJsonlFile(
      context,
      accumulator,
      filePath,
      "run-ledger-jsonl-corrupt",
      false
    );
    if (!rows.length) continue;
    rows.forEach((row) => {
      const event = objectRecord(row);
      if (event) {
        accumulator.observeRecordMetadata(
          "run-event",
          runEventMetadataProjection(event)
        );
      }
    });
    const rowsByRunId = new Map<string, Record<string, unknown>[]>();
    rows.forEach((rowValue, rowPosition) => {
      const row = objectRecord(rowValue);
      if (!row || typeof row.runId !== "string" || !row.runId) {
        accumulator.addCorrupt(
          "run-event-metadata-invalid",
          `${fileName}:${rowPosition}`
        );
        return;
      }
      const bucket = rowsByRunId.get(row.runId) ?? [];
      bucket.push(row);
      rowsByRunId.set(row.runId, bucket);
    });
    const runIds = new Set(rowsByRunId.keys());
    if (runIds.size !== 1) {
      accumulator.addFinding({
        code: "run-id-ambiguous",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: fileName,
        count: Math.max(1, runIds.size),
        blocksMigration: true
      });
    }
    for (const [runId, runRows] of rowsByRunId) {
      const priorFile = runFileOwners.get(runId);
      if (priorFile && priorFile !== fileName) {
        accumulator.addCorrupt("run-ledger-duplicate-id", runId);
      } else {
        runFileOwners.set(runId, fileName);
      }
      facts.runIds.add(runId);
      for (const row of runRows) {
        if (typeof row.eventId !== "string" || !row.eventId) continue;
        const priorOwner = eventIdOwners.get(row.eventId);
        if (priorOwner) {
          accumulator.addCorrupt("run-event-duplicate-id", row.eventId);
        } else {
          eventIdOwners.set(row.eventId, runId);
        }
      }
      const sequences = runRows.map((row) => finiteInteger(row.sequence));
      if (!validRunSequence(sequences)) {
        accumulator.addFinding({
          code: "run-sequence-drift",
          category: "corrupt",
          severity: "blocking",
          recordRaw: runId,
          blocksMigration: true
        });
      }
      const types = runRows
        .map((row) => row.type)
        .filter((value): value is string => typeof value === "string");
      const terminalCount = types.filter(isTerminalRunEvent).length;
      if (terminalCount === 0) {
        accumulator.addFinding({
          code: "run-terminal-missing",
          category: "missing",
          severity: "blocking",
          recordRaw: runId,
          blocksMigration: true
        });
      } else {
        facts.terminalRunIds.add(runId);
        if (terminalCount > 1) {
          accumulator.addFinding({
            code: "run-terminal-ambiguous",
            category: "ambiguous",
            severity: "blocking",
            recordRaw: runId,
            count: terminalCount,
            blocksMigration: true
          });
        }
      }
      if (types.includes("run.local_commit.completed")) {
        facts.locallyCommittedRunIds.add(runId);
      }
    }
    for (const row of rows) accumulator.addTimestamp(objectRecord(row)?.createdAt);
    accumulator.incrementMetric("event-count", rows.length);
  }
  accumulator.recordCount = facts.runIds.size;
  accumulator.incrementMetric("run-count", facts.runIds.size);
  accumulator.incrementMetric("terminal-run-count", facts.terminalRunIds.size);
  accumulator.incrementMetric("local-commit-run-count", facts.locallyCommittedRunIds.size);
  return { accumulator, facts };
}

async function scanRunRecordRetention(
  context: ScanContext
): Promise<SourceScan<RunRecordRetentionFacts>> {
  const accumulator = new SourceAccumulator(
    "run-record-retention",
    context.pluginRoot
  );
  const facts: RunRecordRetentionFacts = { transactionCount: 0 };
  const root = path.join(
    context.pluginRoot,
    RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
  );
  const entries = await listDirectory(context, accumulator, root, true);
  if (!entries) return { accumulator, facts };
  accumulator.schemaVersion = "1";

  if (!entries.includes(".staging")) {
    accumulator.addCorrupt("run-retention-staging-missing", root);
  } else {
    const staged = await listDirectory(
      context,
      accumulator,
      path.join(root, ".staging"),
      false
    );
    if (staged?.length) {
      accumulator.addFinding({
        code: "run-retention-staging-present",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: path.join(root, ".staging"),
        count: staged.length,
        blocksMigration: true
      });
    }
  }

  for (const chainToken of entries
    .filter((name) => name !== ".staging")
    .sort()) {
    if (!/^retention-[a-f0-9]{24}$/.test(chainToken)) {
      accumulator.addCorrupt(
        "run-retention-entry-unsafe",
        chainToken
      );
      continue;
    }
    const chainRoot = path.join(root, chainToken);
    const fileNames = await listDirectory(
      context,
      accumulator,
      chainRoot,
      false
    );
    if (!fileNames?.length) {
      accumulator.addCorrupt(
        "run-retention-chain-corrupt",
        chainToken
      );
      continue;
    }
    const files: Array<{ name: string; value: unknown }> = [];
    let readable = true;
    for (const name of fileNames.sort()) {
      const read = await readTextFile(
        context,
        accumulator,
        path.join(chainRoot, name),
        false
      );
      if (!read) {
        readable = false;
        break;
      }
      let value: unknown;
      try {
        value = JSON.parse(read.text) as unknown;
      } catch {
        readable = false;
        break;
      }
      const raw = objectRecord(value);
      const schemaVersion = finiteInteger(raw?.schemaVersion);
      if (schemaVersion !== null && schemaVersion > 1) {
        accumulator.futureSchemaCount += 1;
        accumulator.markPartial("future-schema");
        accumulator.addFinding({
          code: "future-schema",
          category: "future-schema",
          severity: "blocking",
          recordRaw: path.join(chainRoot, name),
          blocksMigration: true
        });
      }
      files.push({ name, value });
    }
    if (!readable) {
      accumulator.addCorrupt(
        "run-retention-chain-corrupt",
        chainToken
      );
      continue;
    }
    try {
      const inspection = inspectRunRecordRetentionJournalSnapshot({
        chainToken,
        files
      });
      facts.transactionCount += 1;
      accumulator.observeRecordMetadata(
        "run-record-retention",
        inspection
      );
      accumulator.addTimestamp(inspection.createdAt);
      accumulator.incrementMetric(
        "action-count",
        inspection.actionCount
      );
      accumulator.incrementMetric(
        "retention-step-count",
        inspection.stepCount
      );
      accumulator.incrementMetric(
        "retention-completed-action-count",
        inspection.completedActionCount
      );
      accumulator.incrementMetric(
        "retention-pending-action-count",
        inspection.pendingActionCount
      );
      accumulator.incrementMetric(
        "retention-execution-header-count",
        inspection.executionHeaderCount
      );
      accumulator.incrementMetric(
        "retention-prepared-receipt-count",
        inspection.preparedReceiptCount
      );
      accumulator.incrementMetric(
        "retention-finalization-receipt-count",
        inspection.finalizationReceiptCount
      );
    } catch {
      accumulator.addCorrupt(
        "run-retention-chain-corrupt",
        chainToken
      );
    }
  }
  accumulator.recordCount = facts.transactionCount;
  accumulator.incrementMetric(
    "retention-transaction-count",
    facts.transactionCount
  );
  return { accumulator, facts };
}

async function scanRawGcQuarantine(
  context: ScanContext
): Promise<SourceScan<RawGcQuarantineFacts>> {
  const accumulator = new SourceAccumulator(
    "raw-gc-quarantine",
    context.pluginRoot
  );
  const facts: RawGcQuarantineFacts = { transactionCount: 0 };
  const root = path.join(
    context.pluginRoot,
    RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY
  );
  const entries = await listDirectory(context, accumulator, root, true);
  if (!entries) return { accumulator, facts };
  accumulator.schemaVersion = "1";

  if (!entries.includes(".staging")) {
    accumulator.addCorrupt("raw-gc-staging-missing", root);
  } else {
    const staged = await listDirectory(
      context,
      accumulator,
      path.join(root, ".staging"),
      false
    );
    if (staged?.length) {
      accumulator.addFinding({
        code: "raw-gc-staging-present",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: path.join(root, ".staging"),
        count: staged.length,
        blocksMigration: true
      });
    }
  }

  for (const chainToken of entries
    .filter((name) => name !== ".staging")
    .sort()) {
    if (!/^raw-gc-[a-f0-9]{24}$/.test(chainToken)) {
      accumulator.addCorrupt("raw-gc-entry-unsafe", chainToken);
      continue;
    }
    const chainRoot = path.join(root, chainToken);
    const fileNames = await listDirectory(
      context,
      accumulator,
      chainRoot,
      false
    );
    if (!fileNames?.length) {
      accumulator.addCorrupt("raw-gc-chain-corrupt", chainToken);
      continue;
    }
    const files: Array<{ name: string; value: unknown }> = [];
    let readable = true;
    for (const name of fileNames.sort()) {
      const read = await readTextFile(
        context,
        accumulator,
        path.join(chainRoot, name),
        false
      );
      if (!read) {
        readable = false;
        break;
      }
      let value: unknown;
      try {
        value = JSON.parse(read.text) as unknown;
      } catch {
        readable = false;
        break;
      }
      const raw = objectRecord(value);
      const schemaVersion = finiteInteger(raw?.schemaVersion);
      if (schemaVersion !== null && schemaVersion > 1) {
        accumulator.futureSchemaCount += 1;
        accumulator.markPartial("future-schema");
        accumulator.addFinding({
          code: "future-schema",
          category: "future-schema",
          severity: "blocking",
          recordRaw: path.join(chainRoot, name),
          blocksMigration: true
        });
      }
      files.push({ name, value });
    }
    if (!readable) {
      accumulator.addCorrupt("raw-gc-chain-corrupt", chainToken);
      continue;
    }
    try {
      const inspection = inspectRawGcQuarantineJournalSnapshot({
        chainToken,
        files
      });
      facts.transactionCount += 1;
      accumulator.observeRecordMetadata(
        "raw-gc-quarantine",
        inspection
      );
      accumulator.addTimestamp(inspection.createdAt);
      accumulator.incrementMetric(
        "raw-gc-action-count",
        inspection.actionCount
      );
      accumulator.incrementMetric(
        "raw-gc-step-count",
        inspection.stepCount
      );
      accumulator.incrementMetric(
        "raw-gc-quarantined-count",
        inspection.quarantinedCount
      );
      accumulator.incrementMetric(
        "raw-gc-purge-authorized-count",
        inspection.purgeAuthorized ? 1 : 0
      );
      accumulator.incrementMetric(
        "raw-gc-purged-count",
        inspection.purgedCount
      );
      accumulator.incrementMetric(
        "raw-gc-prepared-receipt-count",
        inspection.preparedReceiptCount
      );
      accumulator.incrementMetric(
        "raw-gc-finalization-receipt-count",
        inspection.finalizationReceiptCount
      );
    } catch {
      accumulator.addCorrupt("raw-gc-chain-corrupt", chainToken);
    }
  }
  accumulator.recordCount = facts.transactionCount;
  accumulator.incrementMetric(
    "raw-gc-transaction-count",
    facts.transactionCount
  );
  return { accumulator, facts };
}

async function scanRecordMutations(
  context: ScanContext
): Promise<SourceScan<RecordMutationFacts>> {
  const accumulator = new SourceAccumulator(
    "record-mutations",
    context.pluginRoot
  );
  const facts: RecordMutationFacts = { records: new Map() };
  const root = path.join(context.pluginRoot, "record-mutations");
  const entries = await listDirectory(
    context,
    accumulator,
    root,
    true
  );
  if (!entries) return { accumulator, facts };
  accumulator.schemaVersion = String(RECORD_MUTATION_SCHEMA_VERSION);

  if (!entries.includes(".staging")) {
    accumulator.addCorrupt(
      "record-mutation-staging-missing",
      root
    );
  } else {
    const staged = await listDirectory(
      context,
      accumulator,
      path.join(root, ".staging"),
      false
    );
    if (staged?.length) {
      accumulator.addFinding({
        code: "record-mutation-staging-present",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: path.join(root, ".staging"),
        count: staged.length,
        blocksMigration: true
      });
    }
  }

  for (const chainToken of entries
    .filter((name) => name !== ".staging")
    .sort()) {
    if (!RECORD_MUTATION_CHAIN_TOKEN_PATTERN.test(chainToken)) {
      accumulator.addCorrupt(
        "record-mutation-entry-unsafe",
        chainToken
      );
      continue;
    }
    const chainRoot = path.join(root, chainToken);
    const chainEntries = await listDirectory(
      context,
      accumulator,
      chainRoot,
      false
    );
    if (
      !chainEntries
      || !chainEntries.length
      || chainEntries.length > RECORD_MUTATION_MAX_REVISIONS
    ) {
      accumulator.addCorrupt(
        "record-mutation-chain-corrupt",
        chainToken
      );
      continue;
    }
    const ordered = chainEntries.map((name) => {
      const match = RECORD_MUTATION_ENTRY_PATTERN.exec(name);
      return {
        name,
        revision: match ? Number(match[1]) : -1
      };
    }).sort((left, right) => left.revision - right.revision);
    const chain: RecordMutationRevision[] = [];
    let chainValid = true;
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];
      if (
        entry.revision !== index
        || entry.name
          !== `entry-${String(index).padStart(16, "0")}.json`
      ) {
        accumulator.addCorrupt(
          "record-mutation-chain-corrupt",
          `${chainToken}:${entry.name}`
        );
        chainValid = false;
        break;
      }
      const entryPath = path.join(chainRoot, entry.name);
      const read = await readTextFile(
        context,
        accumulator,
        entryPath,
        false
      );
      if (!read) {
        chainValid = false;
        break;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(read.text) as unknown;
      } catch {
        accumulator.addCorrupt(
          "record-mutation-chain-corrupt",
          entryPath
        );
        chainValid = false;
        break;
      }
      const raw = objectRecord(parsedJson);
      const schemaVersion = finiteInteger(raw?.schemaVersion);
      if (
        schemaVersion !== null
        && schemaVersion > RECORD_MUTATION_SCHEMA_VERSION
      ) {
        accumulator.futureSchemaCount += 1;
        accumulator.markPartial("future-schema");
        accumulator.addFinding({
          code: "future-schema",
          category: "future-schema",
          severity: "blocking",
          recordRaw: entryPath,
          blocksMigration: true
        });
      }
      let revision: RecordMutationRevision;
      try {
        revision = parseRecordMutationRevision(parsedJson);
      } catch {
        accumulator.addCorrupt(
          "record-mutation-chain-corrupt",
          entryPath
        );
        chainValid = false;
        break;
      }
      if (
        revision.revision !== index
        || recordMutationToken(revision.mutationId) !== chainToken
      ) {
        accumulator.addCorrupt(
          "record-mutation-chain-corrupt",
          entryPath
        );
        chainValid = false;
        break;
      }
      if (chain.length) {
        try {
          assertRecordMutationTransition(
            chain[chain.length - 1],
            revision
          );
        } catch {
          accumulator.addCorrupt(
            "record-mutation-chain-corrupt",
            entryPath
          );
          chainValid = false;
          break;
        }
      }
      chain.push(revision);
    }
    if (!chainValid) continue;
    try {
      assertRecordMutationChainCompleteness(chain);
    } catch {
      accumulator.addCorrupt(
        "record-mutation-chain-corrupt",
        chainToken
      );
      continue;
    }
    const current = chain[chain.length - 1];
    if (facts.records.has(current.mutationId)) {
      accumulator.addCorrupt(
        "record-mutation-duplicate-id",
        current.mutationId
      );
      continue;
    }
    facts.records.set(current.mutationId, current);
    accumulator.observeRecordMetadata("record-mutation", {
      mutationId: current.mutationId,
      revision: current.revision,
      state: current.state,
      digest: current.digest,
      intentDigest: current.intentDigest,
      operation: current.intent.operation,
      conversationId: current.intent.conversationId,
      targetConversation: current.intent.targetConversation,
      trashPolicy: current.intent.trashPolicy,
      participantCount: current.intent.participants.length,
      rootBindingCount: current.intent.rootBindings.length,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      terminalCode: current.terminal?.code ?? null
    });
    accumulator.addTimestamp(current.createdAt);
    accumulator.addTimestamp(current.updatedAt);
    accumulator.incrementMetric(`state-${current.state}`);
  }
  accumulator.recordCount = facts.records.size;
  accumulator.incrementMetric("mutation-count", facts.records.size);
  return { accumulator, facts };
}

async function scanNativeStore(context: ScanContext): Promise<SourceScan<NativeFacts>> {
  const accumulator = new SourceAccumulator("native-store", context.pluginRoot);
  const facts: NativeFacts = { records: [] };
  const root = path.join(context.pluginRoot, "harness-native-executions");
  const entries = await listDirectory(context, accumulator, root, false);
  if (!entries) {
    accumulator.markUnavailable("native-store-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }
  const indexPath = path.join(root, "native-executions-index.json");
  const eventsPath = path.join(root, "native-executions.jsonl");
  const indexRead = await readTextFile(context, accumulator, indexPath, false);
  const index = indexRead
    ? parseJsonObject(indexRead.text, accumulator, "native-index-corrupt", indexPath)
    : null;
  if (!indexRead) {
    accumulator.missingCount += 1;
    accumulator.markPartial("native-index-missing");
    accumulator.addFinding({
      code: "native-index-missing",
      category: "missing",
      severity: "blocking",
      recordRaw: "native-index",
      blocksMigration: true
    });
  }
  if (index) {
    const version = finiteInteger(index.version);
    accumulator.schemaVersion = version === null ? null : String(version);
    accumulator.observeRecordMetadata("native-index", {
      version,
      updatedAt: finiteTimestamp(index.updatedAt)
    });
    if (version === null || version < 1) {
      accumulator.addCorrupt("native-index-corrupt", "native-index-version");
    } else if (version > CURRENT_NATIVE_SCHEMA) {
      accumulator.futureSchemaCount += 1;
      accumulator.markPartial("future-schema");
      accumulator.addFinding({
        code: "future-schema",
        category: "future-schema",
        severity: "blocking",
        recordRaw: "native-index",
        blocksMigration: true
      });
    } else {
      if (version < CURRENT_NATIVE_SCHEMA) {
        accumulator.markPartial("native-schema-migration-required");
        accumulator.addFinding({
          code: "native-schema-migration-required",
          category: "ambiguous",
          severity: "blocking",
          recordRaw: "native-index",
          blocksMigration: true
        });
      }
      if (!Array.isArray(index.records)) {
        accumulator.addCorrupt("native-index-corrupt", "native-index-records");
      } else {
        const indexedRecordIds = new Set<string>();
        for (const [indexPosition, value] of index.records.entries()) {
          if (!isNativeExecutionRecord(value)) {
            accumulator.addCorrupt(
              "native-record-invalid",
              `record:${indexPosition}`
            );
            continue;
          }
          if (indexedRecordIds.has(value.id)) {
            accumulator.addCorrupt("native-index-duplicate-id", value.id);
            continue;
          }
          indexedRecordIds.add(value.id);
          accumulator.observeRecordMetadata(
            "native-index-record",
            JSON.parse(nativeRecordMetadataKey(value)) as unknown
          );
          facts.records.push(value);
          accumulator.addTimestamp(value.createdAt);
          accumulator.addTimestamp(value.settledAt);
          accumulator.addTimestamp(value.committedAt);
          accumulator.addTimestamp(value.disposedAt);
          accumulator.addTimestamp(value.cleanupStartedAt);
          accumulator.addTimestamp(value.quarantinedAt);
          if (
            value.cleanup === "awaiting-local-commit"
            || value.cleanup === "pending"
            || value.cleanup === "disposing"
            || value.cleanup === "failed"
          ) {
            accumulator.addFinding({
              code: "cleanup-pending",
              category: "cleanup-pending",
              severity: "warning",
              recordRaw: value.id,
              metadata: [
                {
                  name: "attempt-count",
                  value: nonNegativeInteger(value.attempts)
                }
              ],
              blocksMigration: false
            });
            accumulator.incrementMetric("cleanup-backlog-count");
          }
          if (
            (value.cleanup === "pending" || value.cleanup === "failed")
            && value.attempts >= 6
          ) {
            accumulator.addFinding({
              code: "quarantined-candidate",
              category: "quarantined-candidate",
              severity: "warning",
              recordRaw: value.id,
              metadata: [
                {
                  name: "attempt-count",
                  value: nonNegativeInteger(value.attempts)
                }
              ],
              blocksMigration: false
            });
          }
          if (value.cleanup === "quarantined") {
            accumulator.addFinding({
              code: "cleanup-quarantined",
              category: "quarantined",
              severity: "warning",
              recordRaw: value.id,
              metadata: [
                {
                  name: "attempt-count",
                  value: nonNegativeInteger(value.attempts)
                }
              ],
              blocksMigration: false
            });
          }
        }
      }
    }
  }

  const replayed = await scanNativeAuditProjection(
    context,
    accumulator,
    eventsPath,
    facts.records.length > 0
  );
  const indexed = new Map(facts.records.map((record) => [record.id, record]));
  for (const [id, left] of indexed) {
    const right = replayed.get(id);
    if (!right || nativeRecordMetadataKey(left) !== nativeRecordMetadataKey(right)) {
      accumulator.addFinding({
        code: "native-audit-projection-drift",
        category: right ? "ambiguous" : "missing",
        severity: "warning",
        recordRaw: id,
        blocksMigration: false
      });
    }
  }
  accumulator.recordCount = facts.records.length;
  accumulator.incrementMetric("native-record-count", facts.records.length);
  return { accumulator, facts };
}

async function scanNativeAuditProjection(
  context: ScanContext,
  accumulator: SourceAccumulator,
  eventsPath: string,
  warnIfMissing: boolean
): Promise<Map<string, NativeExecutionRecord>> {
  const replayed = new Map<string, NativeExecutionRecord>();
  const stats = await safeLstat(context, accumulator, eventsPath, true);
  if (!stats) {
    if (warnIfMissing) {
      accumulator.addFinding({
        code: "native-audit-projection-drift",
        category: "missing",
        severity: "warning",
        recordRaw: "native-audit",
        blocksMigration: false
      });
    }
    return replayed;
  }
  if (!stats.isFile()) {
    accumulator.addFinding({
      code: "native-audit-projection-drift",
      category: "ambiguous",
      severity: "warning",
      recordRaw: "native-audit",
      blocksMigration: false
    });
    return replayed;
  }
  accumulator.addFile(eventsPath, stats);
  let text: string;
  try {
    text = await context.fs.readFile(eventsPath, "utf8");
  } catch {
    accumulator.addFinding({
      code: "native-audit-projection-drift",
      category: "ambiguous",
      severity: "warning",
      recordRaw: "native-audit-read",
      blocksMigration: false
    });
    return replayed;
  }

  let invalidCount = 0;
  let eventIndex = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      invalidCount += 1;
      accumulator.observeRecordMetadata("native-audit-event", {
        index: eventIndex,
        valid: false
      });
      eventIndex += 1;
      continue;
    }
    const event = objectRecord(value);
    if (
      event?.type === "upsert"
      && isNativeExecutionRecord(event.record)
    ) {
      replayed.set(event.record.id, event.record);
      accumulator.observeRecordMetadata("native-audit-event", {
        index: eventIndex,
        type: "upsert",
        createdAt: finiteTimestamp(event.createdAt),
        record: JSON.parse(nativeRecordMetadataKey(event.record)) as unknown
      });
    } else if (
      event?.type === "remove"
      && isNonEmptyString(event.id)
    ) {
      replayed.delete(event.id);
      accumulator.observeRecordMetadata("native-audit-event", {
        index: eventIndex,
        type: "remove",
        id: event.id,
        createdAt: finiteTimestamp(event.createdAt)
      });
    } else {
      invalidCount += 1;
      accumulator.observeRecordMetadata("native-audit-event", {
        index: eventIndex,
        type: stringOrNull(event?.type),
        createdAt: finiteTimestamp(event?.createdAt),
        valid: false
      });
    }
    eventIndex += 1;
  }
  if (invalidCount) {
    accumulator.addFinding({
      code: "native-audit-projection-drift",
      category: "ambiguous",
      severity: "warning",
      recordRaw: "native-audit-invalid",
      count: invalidCount,
      blocksMigration: false
    });
  }
  accumulator.incrementMetric("event-count", eventIndex);
  return replayed;
}

async function scanRawMetadata(
  context: ScanContext,
  references: readonly RawReference[]
): Promise<SourceScan<Record<string, never>> & { relations: StorageInventoryRelation[] }> {
  const accumulator = new SourceAccumulator("raw", context.pluginRoot);
  const relations: StorageInventoryRelation[] = [];
  const root = path.join(context.pluginRoot, "raw");
  const entries = await listDirectory(context, accumulator, root, false);
  const availableRefs = new Set<string>();
  if (!entries) {
    accumulator.markUnavailable("raw-store-unavailable");
    accumulator.missingCount += references.length ? references.length : 1;
  } else {
    await walkRawMetadata(context, accumulator, root, root, availableRefs);
  }

  const uniqueReferences = new Map<string, RawReference[]>();
  for (const reference of references) {
    const normalized = normalizeRawRef(reference.rawRef);
    if (!normalized) {
      accumulator.addFinding({
        code: "path-outside-scan-root",
        category: "corrupt",
        severity: "blocking",
        recordRaw: reference.rawRef || "empty-raw-ref",
        blocksMigration: true
      });
      continue;
    }
    const bucket = uniqueReferences.get(normalized) ?? [];
    bucket.push({ ...reference, rawRef: normalized });
    uniqueReferences.set(normalized, bucket);
  }
  for (const [rawRef, owners] of uniqueReferences) {
    const rawEntityRef = opaque("raw-file", rawRef);
    const status = availableRefs.has(rawRef) ? "linked" : "missing";
    for (const owner of owners) {
      relations.push({
        kind: "raw-reference",
        from: {
          sourceId: owner.sourceId,
          entityType: "message",
          ref: owner.ownerRef
        },
        to: {
          sourceId: "raw",
          entityType: "raw-body",
          ref: rawEntityRef
        },
        status
      });
    }
    if (!availableRefs.has(rawRef)) {
      accumulator.missingCount += 1;
      accumulator.addFinding({
        code: "raw-reference-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: rawRef,
        count: owners.length,
        blocksMigration: true
      });
    }
  }
  for (const rawRef of availableRefs) {
    if (uniqueReferences.has(rawRef)) continue;
    accumulator.addFinding({
      code: "raw-file-unreferenced",
      category: "unlinked",
      severity: "warning",
      recordRaw: rawRef,
      blocksMigration: false
    });
  }
  accumulator.recordCount = availableRefs.size;
  accumulator.incrementMetric("raw-reference-count", uniqueReferences.size);
  accumulator.incrementMetric("raw-bodies-read", 0);
  accumulator.incrementMetric("metadata-entry-count", availableRefs.size);
  return { accumulator, facts: {}, relations };
}

async function walkRawMetadata(
  context: ScanContext,
  accumulator: SourceAccumulator,
  root: string,
  current: string,
  refs: Set<string>
): Promise<void> {
  const entries = await listDirectory(context, accumulator, current, true);
  if (!entries) return;
  for (const name of entries.sort()) {
    const target = path.join(current, name);
    const stats = await safeLstat(context, accumulator, target, false);
    if (!stats) continue;
    if (stats.isSymbolicLink()) {
      // safeLstat already emitted the blocking finding and never follows it.
      continue;
    }
    if (stats.isDirectory()) {
      await walkRawMetadata(context, accumulator, root, target, refs);
      continue;
    }
    if (!stats.isFile()) continue;
    accumulator.addFile(target, stats);
    const relative = path.relative(context.pluginRoot, target).replace(/\\/g, "/");
    const normalized = normalizeRawRef(relative);
    if (normalized) refs.add(normalized);
  }
}

function correlateDataAndConversations(
  data: DataFacts,
  conversations: ConversationFacts,
  relations: StorageInventoryRelation[],
  findings: StorageInventoryFinding[]
): void {
  const sessionIds = new Set([...data.sessions.keys(), ...conversations.sessions.keys()]);
  for (const sessionId of [...sessionIds].sort()) {
    const dataSession = data.sessions.get(sessionId);
    const storedSession = conversations.sessions.get(sessionId);
    const status = dataSession && storedSession
      ? "linked"
      : dataSession
        ? "missing"
        : "unlinked";
    relations.push({
      kind: "conversation-authority",
      from: {
        sourceId: "data-json",
        entityType: "session",
        ref: opaque("data-session", sessionId)
      },
      to: {
        sourceId: "conversations",
        entityType: "session",
        ref: opaque("conversation-session", sessionId)
      },
      status
    });
    if (dataSession && !storedSession) {
      findings.push(makeFinding({
        sourceId: "data-json",
        code: "data-conversation-session-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: sessionId,
        blocksMigration: true
      }));
      continue;
    }
    if (!dataSession && storedSession) {
      findings.push(makeFinding({
        sourceId: "conversations",
        code: "conversation-session-unselected",
        category: "unlinked",
        severity: "warning",
        recordRaw: sessionId,
        blocksMigration: false
      }));
      continue;
    }
    if (
      dataSession
      && storedSession
      && dataSession.messageCount > 0
      && !sameSet(dataSession.messageIds, storedSession.messageIds)
    ) {
      findings.push(makeFinding({
        sourceId: "data-json",
        code: "data-conversation-divergence",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: sessionId,
        metadata: [
          { name: "data-message-count", value: dataSession.messageCount },
          { name: "stored-message-count", value: storedSession.messageCount }
        ],
        blocksMigration: true
      }));
    }
  }
}

function correlateHistoryAndConversations(
  history: HistoryFacts,
  conversations: ConversationFacts,
  relations: StorageInventoryRelation[],
  findings: StorageInventoryFinding[]
): void {
  for (const session of history.sessions.values()) {
    const conversation = conversations.sessions.get(session.id);
    relations.push({
      kind: "history-conversation-projection",
      from: {
        sourceId: "history",
        entityType: "session",
        ref: opaque("history-session", session.id)
      },
      to: {
        sourceId: "conversations",
        entityType: "session",
        ref: opaque("conversation-session", session.id)
      },
      status: conversation ? "linked" : "missing"
    });
    if (!conversation) {
      findings.push(makeFinding({
        sourceId: "history",
        code: "history-reference-source-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: session.id,
        count: Math.max(1, session.messageCount),
        blocksMigration: true
      }));
    }
  }
  for (const reference of history.references) {
    const conversation = conversations.sessions.get(
      reference.conversationId
    );
    const message = conversation?.messages.get(reference.messageId);
    let status: StorageInventoryRelation["status"] = "linked";
    let findingCode = "";
    if (!conversation || !message) {
      status = "missing";
      findingCode = "history-reference-source-missing";
    } else if (
      conversation.duplicateMessageIds.has(reference.messageId)
    ) {
      status = "ambiguous";
      findingCode = "history-reference-source-ambiguous";
    } else if (message.revision !== reference.messageRevision) {
      status = "ambiguous";
      findingCode = "history-reference-revision-mismatch";
    } else if (
      localHistoryDateKey(message.createdAt) !== reference.date
    ) {
      status = "ambiguous";
      findingCode = "history-reference-date-drift";
    }
    relations.push({
      kind: "history-message-projection",
      from: {
        sourceId: "history",
        entityType: "message",
        ref: reference.ownerRef
      },
      to: {
        sourceId: "conversations",
        entityType: "message",
        ref: opaque(
          "conversation-message",
          `${reference.conversationId}:${reference.messageId}`
        )
      },
      status
    });
    if (findingCode) {
      findings.push(makeFinding({
        sourceId: "history",
        code: findingCode,
        category: status === "missing" ? "missing" : "ambiguous",
        severity: "blocking",
        recordRaw:
          `${reference.conversationId}:${reference.messageId}`,
        blocksMigration: true
      }));
    }
  }
  if (history.activeSourceRevision) {
    const currentSourceRevision =
      conversationKnowledgeHistorySourceRevision(conversations);
    if (currentSourceRevision !== history.activeSourceRevision) {
      findings.push(makeFinding({
        sourceId: "history",
        code: "history-source-revision-mismatch",
        category: "ambiguous",
        severity: "blocking",
        recordRaw: history.activeGenerationId ?? "active",
        blocksMigration: true
      }));
    }
  }
}

function conversationKnowledgeHistorySourceRevision(
  conversations: ConversationFacts
): string {
  const sessions = [...conversations.sessions.values()]
    .filter((session) => session.kind === "knowledge-base")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => ({
      id: session.id,
      title: session.title ?? "",
      kind: session.kind,
      historyActiveDate: session.historyActiveDate ?? null,
      updatedAt: session.updatedAt,
      messages: session.messageOrder.map((messageId) => {
        const message = session.messages.get(messageId);
        return {
          id: messageId,
          revision: message?.revision ?? "missing"
        };
      })
    }));
  return stableInventoryRevision(sessions);
}

function localHistoryDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function correlateNativeRecords(
  native: NativeFacts,
  runs: RunFacts,
  conversations: ConversationFacts,
  recordMutations: RecordMutationFacts,
  relations: StorageInventoryRelation[],
  findings: StorageInventoryFinding[]
): void {
  for (const record of native.records) {
    const nativeRef = opaque("native-record", record.id);
    if (record.retirement) {
      const retirement = record.retirement;
      const conversation = conversations.sessions.get(
        retirement.targetConversationId
      );
      const conversationExists = Boolean(conversation);
      if (retirement.targetStatus === "deleted") {
        const tombstone = conversations.deletionTombstones.get(
          retirement.targetConversationId
        );
        const mutation = retirement.recordMutationId
          ? recordMutations.records.get(retirement.recordMutationId)
          : undefined;
        const committed =
          deletedRetirementCommittedAuthorityMatches(
            record,
            conversation,
            tombstone,
            mutation
          );
        const aborted =
          deletedRetirementAbortedAuthorityMatches(
            record,
            conversation,
            tombstone,
            mutation
          );
        relations.push({
          kind: "native-conversation-ownership",
          from: {
            sourceId: "native-store",
            entityType: "native-execution",
            ref: nativeRef
          },
          to: {
            sourceId: "conversations",
            entityType: committed ? "tombstone" : "session",
            ref: committed
              ? opaque(
                  "conversation-tombstone",
                  `${retirement.targetConversationId}:`
                  + retirement.targetTombstoneId
                )
              : opaque(
                  "conversation-session",
                  retirement.targetConversationId
                )
          },
          status: committed || aborted
            ? "linked"
            : conversationExists || tombstone
              ? "ambiguous"
              : "missing"
        });
        relations.push({
          kind: "native-retirement-commit",
          from: {
            sourceId: "native-store",
            entityType: "native-execution",
            ref: nativeRef
          },
          to: {
            sourceId: "record-mutations",
            entityType: "mutation",
            ref: opaque(
              "record-mutation",
              retirement.recordMutationId ?? record.id
            )
          },
          status: committed || aborted
            ? "linked"
            : mutation
              ? "ambiguous"
              : "missing"
        });
        if (committed || aborted) continue;
        findings.push(makeFinding({
          sourceId: "native-store",
          code: "native-retirement-commit-mismatch",
          category: "ambiguous",
          severity: "blocking",
          recordRaw: record.id,
          relatedRaw: [
            retirement.targetConversationId,
            retirement.targetTombstoneId,
            retirement.recordMutationId ?? ""
          ],
          blocksMigration: true
        }));
        continue;
      }
      const exactCommit = Boolean(
        conversation
        && record.sessionId === retirement.targetConversationId
        && conversation.generation === retirement.targetGeneration
        && conversation.commitId === retirement.targetCommitId
        && (
          retirement.targetContextId === undefined
          || conversation.contextId === retirement.targetContextId
        )
        && (
          retirement.targetWorkspaceFingerprint === undefined
          || conversation.workspaceFingerprint
            === retirement.targetWorkspaceFingerprint
        )
      );
      relations.push({
        kind: "native-conversation-ownership",
        from: {
          sourceId: "native-store",
          entityType: "native-execution",
          ref: nativeRef
        },
        to: {
          sourceId: "conversations",
          entityType: "session",
          ref: opaque(
            "conversation-session",
            retirement.targetConversationId
          )
        },
        status: conversationExists ? "linked" : "missing"
      });
      relations.push({
        kind: "native-retirement-commit",
        from: {
          sourceId: "native-store",
          entityType: "native-execution",
          ref: nativeRef
        },
        to: {
          sourceId: "conversations",
          entityType: "commit",
          ref: opaque(
            "conversation-commit",
            [
              retirement.targetConversationId,
              retirement.targetGeneration,
              retirement.targetCommitId
            ].join(":")
          )
        },
        status: exactCommit
          ? "linked"
          : conversationExists
            ? "ambiguous"
            : "missing"
      });
      if (!exactCommit) {
        findings.push(makeFinding({
          sourceId: "native-store",
          code: "native-retirement-commit-mismatch",
          category: conversationExists ? "ambiguous" : "missing",
          severity: "blocking",
          recordRaw: record.id,
          relatedRaw: [
            retirement.targetConversationId,
            retirement.targetCommitId
          ],
          blocksMigration: true
        }));
      }
      continue;
    }
    relations.push({
      kind: "native-run-ownership",
      from: { sourceId: "native-store", entityType: "native-execution", ref: nativeRef },
      to: {
        sourceId: "harness-runs",
        entityType: "run",
        ref: opaque("harness-run", record.runId)
      },
      status: runs.runIds.has(record.runId) ? "linked" : "missing"
    });
    relations.push({
      kind: "native-conversation-ownership",
      from: { sourceId: "native-store", entityType: "native-execution", ref: nativeRef },
      to: {
        sourceId: "conversations",
        entityType: "session",
        ref: opaque("conversation-session", record.sessionId)
      },
      status: conversations.sessions.has(record.sessionId) ? "linked" : "missing"
    });
    if (!runs.runIds.has(record.runId)) {
      findings.push(makeFinding({
        sourceId: "native-store",
        code: "native-run-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: record.id,
        relatedRaw: [record.runId],
        blocksMigration: true
      }));
    }
    if (!conversations.sessions.has(record.sessionId)) {
      findings.push(makeFinding({
        sourceId: "native-store",
        code: "native-conversation-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: record.id,
        relatedRaw: [record.sessionId],
        blocksMigration: true
      }));
    }
    if (
      record.localCommit === "committed"
      && runs.runIds.has(record.runId)
      && !runs.locallyCommittedRunIds.has(record.runId)
    ) {
      findings.push(makeFinding({
        sourceId: "harness-runs",
        code: "run-local-commit-missing",
        category: "missing",
        severity: "blocking",
        recordRaw: record.runId,
        relatedRaw: [record.id],
        blocksMigration: true
      }));
    }
  }
}

function deletedRetirementCommittedAuthorityMatches(
  record: NativeExecutionRecord,
  conversation: SessionFact | undefined,
  tombstone: ConversationDeletionTombstoneV1 | undefined,
  mutation: RecordMutationRevision | undefined
): boolean {
  const retirement = record.retirement;
  if (
    retirement?.targetStatus !== "deleted"
    || mutation?.state !== "committed"
    || conversation
    || !tombstone
    || !deletedRetirementMutationIdentityMatches(record, mutation)
  ) {
    return false;
  }
  return (
    tombstone.conversationId === retirement.targetConversationId
    && tombstone.mutationId === retirement.recordMutationId
    && tombstone.tombstoneId === retirement.targetTombstoneId
    && tombstone.digest === retirement.targetTombstoneDigest
    && tombstone.sourceGeneration === retirement.sourceGeneration
    && tombstone.sourceCommitId === retirement.sourceCommitId
    && tombstone.sourceContentRevision
      === mutation.intent.expectedConversationContentRevision
  );
}

function deletedRetirementAbortedAuthorityMatches(
  record: NativeExecutionRecord,
  conversation: SessionFact | undefined,
  tombstone: ConversationDeletionTombstoneV1 | undefined,
  mutation: RecordMutationRevision | undefined
): boolean {
  const retirement = record.retirement;
  if (
    retirement?.targetStatus !== "deleted"
    || mutation?.state !== "aborted"
    || tombstone
    || !conversation
    || record.localCommit !== "failed"
    || record.cleanup !== "aborted"
    || !deletedRetirementMutationIdentityMatches(record, mutation)
  ) {
    return false;
  }
  return (
    conversation.generation === retirement.sourceGeneration
    && conversation.commitId === retirement.sourceCommitId
    && (
      retirement.sourceContextId === undefined
      || retirement.sourceContextId === null
      || conversation.contextId === retirement.sourceContextId
    )
    && (
      retirement.sourceWorkspaceFingerprint === undefined
      || retirement.sourceWorkspaceFingerprint === null
      || conversation.workspaceFingerprint
        === retirement.sourceWorkspaceFingerprint
    )
  );
}

function deletedRetirementMutationIdentityMatches(
  record: NativeExecutionRecord,
  mutation: RecordMutationRevision
): boolean {
  const retirement = record.retirement;
  if (retirement?.targetStatus !== "deleted") return false;
  const target = mutation.intent.targetConversation;
  return (
    mutation.mutationId === retirement.recordMutationId
    && mutation.intent.operation === "delete-conversation"
    && mutation.intent.trashPolicy === "required"
    && mutation.intent.conversationId
      === retirement.targetConversationId
    && record.sessionId === retirement.targetConversationId
    && mutation.intent.expectedConversationGeneration
      === retirement.sourceGeneration
    && mutation.intent.expectedConversationCommitId
      === retirement.sourceCommitId
    && target.status === "deleted"
    && target.tombstoneId === retirement.targetTombstoneId
    && target.digest === retirement.targetTombstoneDigest
  );
}

async function readTextFile(
  context: ScanContext,
  accumulator: SourceAccumulator,
  filePath: string,
  optional: boolean
): Promise<ReadTextResult | null> {
  const stats = await safeLstat(context, accumulator, filePath, optional);
  if (!stats) return null;
  if (!stats.isFile()) {
    accumulator.addCorrupt("expected-file", filePath);
    return null;
  }
  accumulator.addFile(filePath, stats);
  try {
    return {
      text: await context.fs.readFile(filePath, "utf8"),
      stats
    };
  } catch {
    accumulator.addCorrupt("file-read-failed", filePath);
    return null;
  }
}

async function readJsonlFile(
  context: ScanContext,
  accumulator: SourceAccumulator,
  filePath: string,
  corruptCode: string,
  optional: boolean
): Promise<unknown[]> {
  const read = await readTextFile(context, accumulator, filePath, optional);
  if (!read) return [];
  const rows: unknown[] = [];
  let corruptLines = 0;
  for (const line of read.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch {
      corruptLines += 1;
    }
  }
  if (corruptLines) {
    accumulator.corruptCount += corruptLines;
    accumulator.markPartial(corruptCode);
    accumulator.addFinding({
      code: "corrupt-jsonl",
      category: "corrupt",
      severity: "blocking",
      recordRaw: filePath,
      count: corruptLines,
      blocksMigration: true
    });
  }
  return rows;
}

function parseJsonObject(
  text: string,
  accumulator: SourceAccumulator,
  corruptCode: string,
  recordRaw: string
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = objectRecord(parsed);
    if (!record) throw new Error("not-object");
    return record;
  } catch {
    accumulator.corruptCount += 1;
    accumulator.markPartial(corruptCode);
    accumulator.addFinding({
      code: corruptCode,
      category: "corrupt",
      severity: "blocking",
      recordRaw,
      blocksMigration: true
    });
    return null;
  }
}

async function listDirectory(
  context: ScanContext,
  accumulator: SourceAccumulator,
  directoryPath: string,
  optional: boolean
): Promise<string[] | null> {
  const stats = await safeLstat(context, accumulator, directoryPath, optional);
  if (!stats) return null;
  if (!stats.isDirectory()) {
    accumulator.addCorrupt("expected-directory", directoryPath);
    return null;
  }
  try {
    const entries = await context.fs.readdir(directoryPath, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!safePathSegment(name)) {
        accumulator.addFinding({
          code: "path-outside-scan-root",
          category: "corrupt",
          severity: "blocking",
          recordRaw: name || "empty-entry",
          blocksMigration: true
        });
        continue;
      }
      const entryStats = await safeLstat(
        context,
        accumulator,
        path.join(directoryPath, name),
        false
      );
      if (entryStats) names.push(name);
    }
    return names;
  } catch {
    accumulator.markPartial("directory-read-failed");
    accumulator.addFinding({
      code: "directory-read-failed",
      category: "corrupt",
      severity: "blocking",
      recordRaw: directoryPath,
      blocksMigration: true
    });
    return null;
  }
}

async function safeLstat(
  context: ScanContext,
  accumulator: SourceAccumulator,
  target: string,
  optional: boolean
): Promise<ReadOnlyStats | null> {
  if (!isWithin(context.pluginRoot, target)) {
    accumulator.markError("path-outside-scan-root");
    accumulator.addFinding({
      code: "path-outside-scan-root",
      category: "corrupt",
      severity: "blocking",
      recordRaw: target,
      blocksMigration: true
    });
    return null;
  }
  try {
    const stats = await context.fs.lstat(target);
    accumulator.observeEntry(target, stats);
    if (stats.isSymbolicLink()) {
      accumulator.markError("symlink-blocked");
      accumulator.addFinding({
        code: "symlink-blocked",
        category: "corrupt",
        severity: "blocking",
        recordRaw: target,
        blocksMigration: true
      });
      return null;
    }
    try {
      const resolved = await context.fs.realpath(target);
      const realRoot = context.realPluginRoot;
      if (!realRoot || !isWithin(realRoot, resolved)) {
        accumulator.markError("symlink-blocked");
        accumulator.addFinding({
          code: "symlink-blocked",
          category: "corrupt",
          severity: "blocking",
          recordRaw: target,
          blocksMigration: true
        });
        return null;
      }
    } catch {
      accumulator.markError("path-resolution-failed");
      accumulator.addFinding({
        code: "path-resolution-failed",
        category: "corrupt",
        severity: "blocking",
        recordRaw: target,
        blocksMigration: true
      });
      return null;
    }
    return stats;
  } catch (error) {
    if (isNotFound(error)) {
      if (!optional) accumulator.markPartial("entry-missing");
      return null;
    }
    accumulator.markError("metadata-read-failed");
    accumulator.addFinding({
      code: "metadata-read-failed",
      category: "corrupt",
      severity: "blocking",
      recordRaw: target,
      blocksMigration: true
    });
    return null;
  }
}

async function verifyRootBoundary(context: ScanContext): Promise<string | null> {
  try {
    const rootStats = await context.fs.lstat(context.pluginRoot);
    if (rootStats.isSymbolicLink()) return "symlink-blocked";
  } catch (error) {
    return isNotFound(error) ? "scan-root-unavailable" : "metadata-read-failed";
  }
  try {
    const [vaultReal, pluginReal] = await Promise.all([
      context.fs.realpath(context.vaultPath),
      context.fs.realpath(context.pluginRoot)
    ]);
    if (!isWithin(vaultReal, pluginReal)) return "symlink-blocked";
    context.realPluginRoot = pluginReal;
    return null;
  } catch {
    return "path-resolution-failed";
  }
}

function collectMessageFacts(
  rows: readonly unknown[],
  accumulator: SourceAccumulator,
  sourceId: StorageInventoryLocalSourceId,
  owner: string
): MessageFact[] {
  const facts: MessageFact[] = [];
  const seen = new Set<string>();
  for (const [index, value] of rows.entries()) {
    const message = objectRecord(value);
    if (!message || typeof message.id !== "string" || !message.id) {
      accumulator.addCorrupt("message-metadata-invalid", `${owner}:${index}`);
      continue;
    }
    if (seen.has(message.id)) {
      accumulator.addFinding({
        code: "duplicate-message-id",
        category: "ambiguous",
        severity: "warning",
        recordRaw: `${owner}:${message.id}`,
        blocksMigration: false
      });
    }
    seen.add(message.id);
    accumulator.observeRecordMetadata(`${sourceId}-message`, {
      owner,
      index,
      metadata: messageMetadataProjection(message)
    });
    facts.push({
      id: message.id,
      createdAt: timestampOrZero(message.createdAt),
      revision: createConversationProductMessageRevision(
        message as unknown as ChatMessage
      ),
      ...(typeof message.rawRef === "string" && message.rawRef
        ? { rawRef: message.rawRef }
        : {}),
      ...(typeof message.runId === "string" && message.runId
        ? { runId: message.runId }
        : {})
    });
  }
  void sourceId;
  return facts;
}

function messageFactMap(
  facts: readonly MessageFact[]
): Map<string, MessageFact> {
  const messages = new Map<string, MessageFact>();
  for (const fact of facts) messages.set(fact.id, fact);
  return messages;
}

function duplicateMessageFactIds(
  facts: readonly MessageFact[]
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.id)) duplicates.add(fact.id);
    seen.add(fact.id);
  }
  return duplicates;
}

function nativeRecordMetadataKey(record: NativeExecutionRecord): string {
  return JSON.stringify({
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    surface: record.surface,
    workflow: record.workflow,
    native: {
      backendId: record.native.backendId,
      id: record.native.id,
      kind: record.native.kind,
      persistence: record.native.persistence,
      transport: record.native.transport ?? null,
      providerEndpoint: record.native.providerEndpoint ?? null,
      deviceKey: record.native.deviceKey,
      vaultId: record.native.vaultId,
      createdAt: record.native.createdAt
    },
    policy: {
      historyAuthority: record.policy.historyAuthority,
      mode: record.policy.mode,
      preferredDisposition: record.policy.preferredDisposition,
      retainWhenLocalCommitFails: record.policy.retainWhenLocalCommitFails,
      cleanupRequiredForTaskSuccess: record.policy.cleanupRequiredForTaskSuccess
    },
    runOutcome: record.runOutcome ?? null,
    localCommit: record.localCommit,
    cleanup: record.cleanup,
    requestedDisposition: record.requestedDisposition ?? null,
    appliedDisposition: record.appliedDisposition ?? null,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    committedAt: record.committedAt,
    disposedAt: record.disposedAt,
    cleanupStartedAt: record.cleanupStartedAt ?? null,
    quarantinedAt: record.quarantinedAt ?? null,
    retirement: record.retirement
      ? {
        targetConversationId: record.retirement.targetConversationId,
        ...(nativeRetirementSourceIdentityState(record.retirement) === "complete"
          ? {
            sourceGeneration: record.retirement.sourceGeneration,
            sourceCommitId: record.retirement.sourceCommitId,
            sourceContextId: record.retirement.sourceContextId,
            sourceWorkspaceFingerprint:
              record.retirement.sourceWorkspaceFingerprint
          }
          : {}),
        ...(record.retirement.targetStatus === "deleted"
          ? {
            targetStatus: "deleted",
            targetTombstoneId: record.retirement.targetTombstoneId,
            targetTombstoneDigest:
              record.retirement.targetTombstoneDigest
          }
          : {
            targetStatus: "present",
            targetGeneration: record.retirement.targetGeneration,
            targetCommitId: record.retirement.targetCommitId,
            targetContextId: record.retirement.targetContextId ?? null,
            targetWorkspaceFingerprint:
              record.retirement.targetWorkspaceFingerprint ?? null
          }),
        reason: record.retirement.reason
      }
      : null,
    emitEvents: record.emitEvents ?? null,
    dispositionReason: record.dispositionReason ?? null
  });
}

function isNativeExecutionRecord(value: unknown): value is NativeExecutionRecord {
  const record = objectRecord(value);
  const native = objectRecord(record?.native);
  const policy = objectRecord(record?.policy);
  return Boolean(
    record
    && isNonEmptyString(record.id)
    && isNonEmptyString(record.runId)
    && isNonEmptyString(record.sessionId)
    && isOneOf(record.surface, ["knowledge", "editor", "review", "chat", "system"])
    && isNonEmptyString(record.workflow)
    && native
    && isNonEmptyString(native.id)
    && isNonEmptyString(native.backendId)
    && isOneOf(native.kind, ["thread", "session", "run", "process"])
    && isOneOf(native.persistence, [
      "none",
      "process-local",
      "provider-persistent",
      "unknown"
    ])
    && (
      native.transport === undefined
      || isSafeNativeExecutionTransport(native.transport)
    )
    && (native.providerEndpoint === undefined || typeof native.providerEndpoint === "string")
    && isNonEmptyString(native.deviceKey)
    && isNonEmptyString(native.vaultId)
    && isSafeTimestamp(native.createdAt)
    && policy
    && isOneOf(policy.historyAuthority, ["echoink", "backend", "hybrid"])
    && isOneOf(policy.mode, [
      "ephemeral-run",
      "leased-conversation",
      "persistent-native"
    ])
    && Array.isArray(policy.preferredDisposition)
    && policy.preferredDisposition.every((item) =>
      isOneOf(item, ["process-exit", "archive", "delete", "retain"]))
    && typeof policy.retainWhenLocalCommitFails === "boolean"
    && policy.cleanupRequiredForTaskSuccess === false
    && (record.runOutcome === undefined
      || isOneOf(record.runOutcome, ["success", "failed", "cancelled"]))
    && isOneOf(record.localCommit, ["pending", "committed", "failed"])
    && isOneOf(record.cleanup, [
      "not-needed",
      "awaiting-local-commit",
      "pending",
      "disposing",
      "disposed",
      "unsupported",
      "failed",
      "retained-for-recovery",
      "retained",
      "aborted",
      "quarantined"
    ])
    && (record.requestedDisposition === undefined
      || isOneOf(record.requestedDisposition, [
        "process-exit",
        "archive",
        "delete",
        "retain"
      ]))
    && (record.appliedDisposition === undefined
      || isOneOf(record.appliedDisposition, [
        "process-exit",
        "archive",
        "delete",
        "retain"
      ]))
    && isSafeNonNegativeInteger(record.attempts)
    && isSafeTimestamp(record.nextAttemptAt)
    && typeof record.lastError === "string"
    && isSafeTimestamp(record.createdAt)
    && isSafeTimestamp(record.settledAt)
    && isSafeTimestamp(record.committedAt)
    && isSafeTimestamp(record.disposedAt)
    && (
      record.cleanupStartedAt === undefined
      || isSafeTimestamp(record.cleanupStartedAt)
    )
    && (
      record.quarantinedAt === undefined
      || isSafeTimestamp(record.quarantinedAt)
    )
    && isNativeRetirement(record.retirement)
    && (record.emitEvents === undefined || typeof record.emitEvents === "boolean")
    && (record.dispositionReason === undefined
      || isOneOf(record.dispositionReason, [
        "knowledge-run-completed",
        "knowledge-run-failed",
        "knowledge-run-cancelled",
        "recovery",
        "manual"
      ]))
  );
}

function isNativeRetirement(
  value: unknown
): boolean {
  if (value === undefined) return true;
  const retirement = objectRecord(value);
  return Boolean(
    retirement
    && isNonEmptyString(retirement.targetConversationId)
    && nativeRetirementSourceIdentityState(retirement) !== "invalid"
    && nativeRetirementTargetState(retirement) !== "invalid"
    && (
      nativeRetirementTargetState(retirement) !== "deleted"
      || (
        isNonEmptyString(retirement.recordMutationId)
        && nativeRetirementSourceIdentityState(retirement) === "complete"
        && retirement.reason === "delete-conversation"
      )
    )
    && isNonEmptyString(retirement.reason)
  );
}

function validRunSequence(values: readonly (number | null)[]): boolean {
  if (!values.length || values.some((value) => value === null)) return false;
  const sequence = values as number[];
  if (sequence[0] !== 1) return false;
  if (new Set(sequence).size !== sequence.length) return false;
  for (let index = 1; index < sequence.length; index += 1) {
    if (sequence[index] !== sequence[index - 1] + 1) return false;
  }
  return true;
}

function isTerminalRunEvent(value: string): boolean {
  return value === "run.completed" || value === "run.failed" || value === "run.cancelled";
}

class SourceAccumulator {
  status: StorageInventorySourceStatus = "scanned";
  schemaVersion: string | null = null;
  recordCount = 0;
  fileCount = 0;
  byteCount = 0;
  missingCount = 0;
  corruptCount = 0;
  futureSchemaCount = 0;
  statusCode: string | undefined;
  readonly findings: StorageInventoryFinding[] = [];
  readonly relations: StorageInventoryRelation[] = [];
  private readonly metricValues = new Map<string, number>();
  private readonly timestamps: number[] = [];
  private readonly structureMetadata = new Map<string, string>();
  private readonly recordMetadata: string[] = [];

  constructor(
    readonly sourceId: StorageInventoryLocalSourceId,
    private readonly pluginRoot: string
  ) {}

  addFile(filePath: string, stats: ReadOnlyStats): void {
    this.fileCount += 1;
    this.byteCount += nonNegativeInteger(stats.size);
    this.addTimestamp(stats.mtimeMs);
    this.observeEntry(filePath, stats);
  }

  observeEntry(entryPath: string, stats: ReadOnlyStats): void {
    const relative = path.relative(this.pluginRoot, entryPath).replace(/\\/g, "/");
    const fileType = stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other";
    this.structureMetadata.set(relative, [
      relative,
      fileType,
      nonNegativeInteger(stats.size),
      safeTimestamp(stats.mtimeMs)
    ].join(":"));
  }

  observeRecordMetadata(kind: string, value: unknown): void {
    this.recordMetadata.push(
      `${safeToken(kind)}:${stableCanonicalJson(value)}`
    );
  }

  addTimestamp(value: unknown): void {
    const timestamp = finiteTimestamp(value);
    if (timestamp !== null) this.timestamps.push(timestamp);
  }

  incrementMetric(name: string, amount = 1): void {
    const safeName = safeToken(name);
    this.metricValues.set(
      safeName,
      (this.metricValues.get(safeName) ?? 0) + nonNegativeInteger(amount)
    );
  }

  addCorrupt(code: string, recordRaw: string): void {
    this.corruptCount += 1;
    this.markPartial(code);
    this.addFinding({
      code,
      category: "corrupt",
      severity: "blocking",
      recordRaw,
      blocksMigration: true
    });
  }

  addFinding(input: Omit<FindingInput, "sourceId">): void {
    this.findings.push(makeFinding({ ...input, sourceId: this.sourceId }));
  }

  markPartial(code: string): void {
    if (this.status === "scanned") this.status = "partial";
    this.statusCode ??= safeToken(code);
  }

  markUnavailable(code: string): void {
    if (this.status !== "error") this.status = "unavailable";
    this.statusCode ??= safeToken(code);
  }

  markError(code: string): void {
    this.status = "error";
    this.statusCode ??= safeToken(code);
  }

  finalize(): StorageInventorySource {
    const timestamps = this.timestamps.filter((value) => value >= 0);
    const metrics = [...this.metricValues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value }));
    return {
      sourceId: this.sourceId,
      status: this.status,
      schemaVersion: this.schemaVersion,
      recordCount: nonNegativeInteger(this.recordCount),
      fileCount: nonNegativeInteger(this.fileCount),
      byteCount: nonNegativeInteger(this.byteCount),
      timeRange: {
        oldestAt: timestamps.length ? Math.min(...timestamps) : null,
        newestAt: timestamps.length ? Math.max(...timestamps) : null
      },
      missingCount: nonNegativeInteger(this.missingCount),
      corruptCount: nonNegativeInteger(this.corruptCount),
      futureSchemaCount: nonNegativeInteger(this.futureSchemaCount),
      generation: this.structureMetadata.size
        ? opaque(
          "source-generation",
          [
            this.sourceId,
            "structure",
            ...[...this.structureMetadata.values()].sort(),
            "records",
            ...this.recordMetadata.sort()
          ].join("\n")
        )
        : this.recordMetadata.length
          ? opaque(
            "source-generation",
            [this.sourceId, "records", ...this.recordMetadata.sort()].join("\n")
          )
          : null,
      ...(metrics.length ? { metrics } : {}),
      ...(this.statusCode ? { statusCode: this.statusCode } : {})
    };
  }
}

interface FindingInput {
  sourceId: string;
  code: string;
  category: StorageInventoryFindingCategory;
  severity: StorageInventoryFindingSeverity;
  recordRaw?: string;
  relatedRaw?: readonly string[];
  count?: number;
  metadata?: readonly StorageInventoryFindingMetadata[];
  blocksMigration: boolean;
}

function makeFinding(input: FindingInput): StorageInventoryFinding {
  const code = safeToken(input.code);
  const recordRef = input.recordRaw
    ? opaque(`${safeToken(input.sourceId)}-record`, input.recordRaw)
    : undefined;
  const relatedRefs = input.relatedRaw?.map((value) =>
    opaque(`${safeToken(input.sourceId)}-related`, value));
  const stable = [
    input.sourceId,
    code,
    recordRef ?? "",
    ...(relatedRefs ?? [])
  ].join("|");
  return {
    findingId: opaque("finding", stable),
    category: input.category,
    code,
    severity: input.severity,
    sourceId: input.sourceId,
    ...(recordRef ? { recordRef } : {}),
    ...(relatedRefs?.length ? { relatedRefs } : {}),
    count: Math.max(1, nonNegativeInteger(input.count ?? 1)),
    ...(input.metadata?.length ? { metadata: input.metadata } : {}),
    blocksMigration: input.blocksMigration,
    automaticActionAllowed: false
  };
}

function deduplicateFindings(
  findings: readonly StorageInventoryFinding[]
): StorageInventoryFinding[] {
  const byId = new Map<string, StorageInventoryFinding>();
  for (const finding of findings) {
    const existing = byId.get(finding.findingId);
    if (!existing) {
      byId.set(finding.findingId, finding);
      continue;
    }
    byId.set(finding.findingId, {
      ...existing,
      count: existing.count + finding.count
    });
  }
  return [...byId.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
    || left.code.localeCompare(right.code)
    || left.findingId.localeCompare(right.findingId));
}

function deduplicateRelations(
  relations: readonly StorageInventoryRelation[]
): StorageInventoryRelation[] {
  const byKey = new Map<string, StorageInventoryRelation>();
  for (const relation of relations) {
    const key = [
      relation.kind,
      relation.from.sourceId,
      relation.from.ref,
      relation.to.sourceId,
      relation.to.ref,
      relation.status
    ].join("|");
    byKey.set(key, relation);
  }
  return [...byKey.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.from.ref.localeCompare(right.from.ref)
    || left.to.ref.localeCompare(right.to.ref));
}

function buildMigrationPreview(
  sources: readonly StorageInventorySource[],
  providers: StorageInventoryReportInput["providers"],
  findings: readonly StorageInventoryFinding[]
): StorageInventoryReportInput["migrationPreview"] {
  const blockingFindingIds = findings
    .filter((finding) => finding.blocksMigration)
    .map((finding) => finding.findingId);
  const partial = sources.some((source) => source.status !== "scanned")
    || providers.some((provider) =>
      provider.nativeScope !== "none"
      && provider.status !== "scanned"
      && provider.status !== "unsupported")
    || findings.some((finding) => finding.category !== "linked");
  return {
    status: blockingFindingIds.length ? "blocked" : partial ? "partial" : "ready",
    blockingFindingIds,
    candidateRecordCount: findings
      .filter((finding) =>
        finding.category === "unlinked"
        || finding.category === "ambiguous"
        || finding.category === "quarantined"
        || finding.category === "quarantined-candidate")
      .reduce((sum, finding) => sum + finding.count, 0),
    wouldCreateRecordCount: 0,
    wouldUpdateRecordCount: 0,
    wouldRetainRecordCount: sources.reduce((sum, source) => sum + source.recordCount, 0),
    destructiveActionCount: 0,
    automaticActionAllowed: false
  };
}

function blockedRootReport(
  generatedAt: number,
  pluginDir: string,
  nativeScope: NativeInventoryScope,
  vaultPath: string,
  code = "path-outside-scan-root"
): StorageInventoryReportInput {
  const finding = makeFinding({
    sourceId: "data-json",
    code,
    category: "corrupt",
    severity: "blocking",
    recordRaw: pluginDir,
    blocksMigration: true
  });
  return {
    generatedAt,
    scope: {
      vaultRef: opaque("vault", path.resolve(vaultPath)),
      pluginDir,
      nativeScope
    },
    sources: LOCAL_SOURCE_IDS.map((sourceId) => ({
      sourceId,
      status: "error",
      schemaVersion: null,
      recordCount: 0,
      fileCount: 0,
      byteCount: 0,
      timeRange: { oldestAt: null, newestAt: null },
      missingCount: 0,
      corruptCount: sourceId === "data-json" ? 1 : 0,
      futureSchemaCount: 0,
      generation: null,
      statusCode: safeToken(code)
    })),
    providers: (["codex", "opencode", "hermes"] as const).map((providerId) => ({
      providerId,
      status: "unavailable",
      nativeScope,
      capabilities: {
        enumerate: "unknown",
        inspectExistence: "unknown",
        resume: "unknown",
        archive: "unknown",
        delete: "unknown"
      },
      linkedCount: 0,
      inspectedCount: 0,
      existingCount: 0,
      missingCount: 0,
      unownedCandidateCount: 0,
      statusCode: "local-scan-blocked"
    })),
    relations: [],
    findings: [finding],
    migrationPreview: {
      status: "blocked",
      blockingFindingIds: [finding.findingId],
      candidateRecordCount: 0,
      wouldCreateRecordCount: 0,
      wouldUpdateRecordCount: 0,
      wouldRetainRecordCount: 0,
      destructiveActionCount: 0,
      automaticActionAllowed: false
    }
  };
}

function resolvePluginRoot(
  vaultPath: string,
  pluginDir = "codex-echoink"
): { safe: boolean; pluginDir: string; pluginRoot: string } {
  const normalized = pluginDir.trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  const pluginName = segments.length === 1 && segments[0]
    ? segments[0]
    : "invalid-plugin-dir";
  const safePluginName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pluginName)
    ? pluginName
    : "invalid-plugin-dir";
  const safe = segments.length === 1
    && safePluginName === pluginName
    && !path.isAbsolute(pluginDir);
  const vault = path.resolve(vaultPath);
  const pluginRoot = pluginDataDir(vault, safePluginName);
  return {
    safe: safe && isWithin(vault, pluginRoot),
    pluginDir: safePluginName,
    pluginRoot
  };
}

function normalizeRawRef(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !normalized.startsWith("raw/")
    || normalized === "raw/"
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function observeConversationLegacyId(
  ownersByPathPart: Map<string, Set<string>>,
  sessionId: string
): void {
  const pathPart = legacyConversationPathPart(sessionId);
  const owners = ownersByPathPart.get(pathPart) ?? new Set<string>();
  owners.add(sessionId);
  ownersByPathPart.set(pathPart, owners);
}

function sanitizeHistoryPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function safePathSegment(value: string): boolean {
  return Boolean(
    value
    && value !== "."
    && value !== ".."
    && path.basename(value) === value
    && !value.includes("/")
    && !value.includes("\\")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isSafeTimestamp(value: unknown): value is number {
  return isSafeNonNegativeInteger(value)
    && value <= 8_640_000_000_000_000;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function conversationGeneration(
  session: Record<string, unknown> | null
): number {
  if (!session) return 1;
  return Math.max(
    finiteInteger(session.generation) ?? 0,
    finiteInteger(session.revision) ?? 0,
    1
  );
}

function nonEmptyStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? safeTimestamp(value)
    : null;
}

function timestampOrZero(value: unknown): number {
  return finiteTimestamp(value) ?? 0;
}

function safeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(8_640_000_000_000_000, Math.round(value));
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function minimumPositive(values: readonly number[]): number {
  const positive = values.filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

function maximumPositive(values: readonly number[]): number {
  const positive = values.filter((value) => value > 0);
  return positive.length ? Math.max(...positive) : 0;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sessionMetadataProjection(
  session: Record<string, unknown>
): Record<string, unknown> {
  const bindings = objectRecord(session.backendBindings);
  return {
    id: stringOrNull(session.id),
    kind: stringOrNull(session.kind),
    threadId: stringOrNull(session.threadId),
    revision: finiteInteger(session.revision),
    generation: finiteInteger(session.generation),
    contextId: stringOrNull(session.contextId),
    contextStartsAfterMessageId: stringOrNull(
      session.contextStartsAfterMessageId
    ),
    commitId: stringOrNull(session.commitId),
    workspaceFingerprint: stringOrNull(session.workspaceFingerprint),
    payloadVersion: finiteInteger(session.payloadVersion),
    payloadKey: stringOrNull(session.payloadKey),
    previousPayloadKey: stringOrNull(session.previousPayloadKey),
    previousPayloadCommitId: stringOrNull(session.previousPayloadCommitId),
    cwd: stringOrNull(session.cwd),
    messagesHiddenBefore: finiteTimestamp(session.messagesHiddenBefore),
    historyActiveDate: stringOrNull(session.historyActiveDate),
    createdAt: finiteTimestamp(session.createdAt),
    updatedAt: finiteTimestamp(session.updatedAt),
    rollingSummaryUpdatedAt: finiteTimestamp(
      objectRecord(session.rollingSummary)?.updatedAt
    ),
    contextSnapshot: snapshotMetadataProjection(session.contextSnapshot),
    backendBindings: bindings
      ? Object.fromEntries(
        Object.entries(bindings)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([backendId, binding]) => [
            backendId,
            backendBindingMetadataProjection(binding)
          ])
      )
      : null
  };
}

function backendBindingMetadataProjection(value: unknown): unknown {
  const binding = objectRecord(value);
  if (!binding) return null;
  const native = objectRecord(binding.nativeExecutionRef);
  const cursor = objectRecord(binding.contextCursor);
  return {
    backendId: stringOrNull(binding.backendId),
    nativeSessionId: stringOrNull(binding.nativeSessionId),
    nativeThreadId: stringOrNull(binding.nativeThreadId),
    nativeExecutionKind: stringOrNull(binding.nativeExecutionKind),
    nativeExecutionRef: native
      ? {
        backendId: stringOrNull(native.backendId),
        id: stringOrNull(native.id),
        kind: stringOrNull(native.kind),
        persistence: stringOrNull(native.persistence),
        transport: stringOrNull(native.transport),
        providerEndpoint: stringOrNull(native.providerEndpoint),
        deviceKey: stringOrNull(native.deviceKey),
        vaultId: stringOrNull(native.vaultId),
        createdAt: finiteTimestamp(native.createdAt)
      }
      : null,
    leaseId: stringOrNull(binding.leaseId),
    leaseStatus: stringOrNull(binding.leaseStatus),
    leaseCreatedAt: finiteTimestamp(binding.leaseCreatedAt),
    leaseLastUsedAt: finiteTimestamp(binding.leaseLastUsedAt),
    leaseExpiresAt: finiteTimestamp(binding.leaseExpiresAt),
    leaseTurnCount: finiteInteger(binding.leaseTurnCount),
    leaseMaxTurns: finiteInteger(binding.leaseMaxTurns),
    leaseContextChars: finiteInteger(binding.leaseContextChars),
    leaseMaxContextChars: finiteInteger(binding.leaseMaxContextChars),
    contextCheckpointMessageId: stringOrNull(
      binding.contextCheckpointMessageId
    ),
    syncedThroughMessageId: stringOrNull(binding.syncedThroughMessageId),
    syncedSessionRevision: finiteInteger(binding.syncedSessionRevision),
    snapshotVersion: stringOrNull(binding.snapshotVersion),
    contextCursor: cursor
      ? {
        syncedThroughMessageId: stringOrNull(cursor.syncedThroughMessageId),
        syncedSessionRevision: finiteInteger(cursor.syncedSessionRevision),
        sessionGeneration: finiteInteger(cursor.sessionGeneration),
        contextId: stringOrNull(cursor.contextId),
        workspaceFingerprint: stringOrNull(cursor.workspaceFingerprint),
        snapshotVersion: stringOrNull(cursor.snapshotVersion)
      }
      : null,
    workspaceFingerprint: stringOrNull(binding.workspaceFingerprint),
    vaultProfileFingerprint: stringOrNull(binding.vaultProfileFingerprint),
    lastUsedAt: finiteTimestamp(binding.lastUsedAt)
  };
}

function snapshotMetadataProjection(value: unknown): unknown {
  const snapshot = objectRecord(value);
  if (!snapshot) return null;
  return {
    sessionId: stringOrNull(snapshot.sessionId),
    contextId: stringOrNull(snapshot.contextId),
    generation: finiteInteger(snapshot.generation),
    version: stringOrNull(snapshot.version),
    summarizedFromMessageId: stringOrNull(snapshot.summarizedFromMessageId),
    summarizedThroughMessageId: stringOrNull(
      snapshot.summarizedThroughMessageId
    ),
    sourceMessageCount: finiteInteger(snapshot.sourceMessageCount),
    decisionCount: arrayLength(snapshot.decisions),
    constraintCount: arrayLength(snapshot.constraints),
    openLoopCount: arrayLength(snapshot.openLoops),
    keyReferenceCount: arrayLength(snapshot.keyReferences),
    createdAt: finiteTimestamp(snapshot.createdAt),
    updatedAt: finiteTimestamp(snapshot.updatedAt)
  };
}

function messageMetadataProjection(
  message: Record<string, unknown>
): Record<string, unknown> {
  const usage = objectRecord(message.runUsage);
  return {
    id: stringOrNull(message.id),
    role: stringOrNull(message.role),
    backendId: stringOrNull(message.backendId),
    modelId: stringOrNull(message.modelId),
    profileId: stringOrNull(message.profileId),
    nativeExecutionIdHash: stringOrNull(message.nativeExecutionIdHash),
    contextMode: stringOrNull(message.contextMode),
    contextCompiledThroughMessageId: stringOrNull(
      message.contextCompiledThroughMessageId
    ),
    contextSnapshotVersion: stringOrNull(message.contextSnapshotVersion),
    nativeLeaseId: stringOrNull(message.nativeLeaseId),
    nativeLeaseStatus: stringOrNull(message.nativeLeaseStatus),
    nativeLeaseTurnCount: finiteInteger(message.nativeLeaseTurnCount),
    nativeLeaseReused: booleanOrNull(message.nativeLeaseReused),
    nativeLocalCommitStatus: stringOrNull(message.nativeLocalCommitStatus),
    nativeCleanupStatus: stringOrNull(message.nativeCleanupStatus),
    runTerminalRecoveryPending: stringOrNull(
      message.runTerminalRecoveryPending
    ),
    runTerminalRecovered: booleanOrNull(message.runTerminalRecovered),
    rawRef: stringOrNull(message.rawRef),
    rawSize: finiteInteger(message.rawSize),
    rawLines: finiteInteger(message.rawLines),
    rawTruncatedForPreview: booleanOrNull(message.rawTruncatedForPreview),
    phase: stringOrNull(message.phase),
    itemType: stringOrNull(message.itemType),
    runId: stringOrNull(message.runId),
    turnId: stringOrNull(message.turnId),
    processKind: stringOrNull(message.processKind),
    status: stringOrNull(message.status),
    processContentAvailability: stringOrNull(
      message.processContentAvailability
    ),
    processInputAvailability: stringOrNull(
      message.processInputAvailability
    ),
    processOutputAvailability: stringOrNull(
      message.processOutputAvailability
    ),
    attachmentCount: arrayLength(message.attachments),
    fileCount: arrayLength(message.files),
    imageCount: arrayLength(message.images),
    usage: usage
      ? {
        totalTokens: finiteInteger(usage.totalTokens),
        inputTokens: finiteInteger(usage.inputTokens),
        outputTokens: finiteInteger(usage.outputTokens),
        reasoningTokens: finiteInteger(usage.reasoningTokens),
        cacheReadTokens: finiteInteger(usage.cacheReadTokens),
        cacheWriteTokens: finiteInteger(usage.cacheWriteTokens),
        cost: finiteNonNegativeNumber(usage.cost)
      }
      : null,
    createdAt: finiteTimestamp(message.createdAt),
    completedAt: finiteTimestamp(message.completedAt)
  };
}

function runEventMetadataProjection(
  event: Record<string, unknown>
): Record<string, unknown> {
  const data = objectRecord(event.data);
  return {
    eventId: stringOrNull(event.eventId),
    runId: stringOrNull(event.runId),
    sequence: finiteInteger(event.sequence),
    createdAt: finiteTimestamp(event.createdAt),
    source: stringOrNull(event.source),
    type: stringOrNull(event.type),
    backendId: stringOrNull(event.backendId),
    status: stringOrNull(event.status),
    toolName: stringOrNull(event.toolName),
    resourceId: stringOrNull(event.resourceId),
    data: data
      ? {
        messageId: stringOrNull(data.messageId),
        blockId: stringOrNull(data.blockId),
        reasoningKind: stringOrNull(data.reasoningKind),
        visibility: stringOrNull(data.visibility),
        callId: stringOrNull(data.callId),
        toolCallId: stringOrNull(data.toolCallId),
        semanticKind: stringOrNull(data.semanticKind),
        toolStatus: stringOrNull(data.toolStatus),
        inputState: stringOrNull(data.inputState),
        outputState: stringOrNull(data.outputState),
        fileCount: arrayLength(data.files),
        promptSubmitted: booleanOrNull(data.promptSubmitted),
        unconfirmedToolCallCount: finiteInteger(
          data.unconfirmedToolCallCount
        )
      }
      : null
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortCanonicalValue(nested)])
  );
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "ENOENT"
  );
}

function opaque(namespace: string, raw: string): string {
  return createStorageInventoryOpaqueRef(safeToken(namespace), raw || "unknown");
}

function safeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
    || "unknown";
}
