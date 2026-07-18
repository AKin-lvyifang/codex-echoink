import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath
} from "node:fs/promises";
import * as path from "node:path";
import { pluginDataDir } from "../../core/raw-message-store";
import type { NativeExecutionRecord } from "../contracts/native-execution";
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
const CURRENT_HISTORY_SCHEMA = 1;
const CURRENT_NATIVE_SCHEMA = 1;
const LOCAL_SOURCE_IDS: readonly StorageInventoryLocalSourceId[] = [
  "data-json",
  "conversations",
  "history",
  "harness-runs",
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
  rawRef?: string;
  runId?: string;
}

interface SessionFact {
  id: string;
  messageIds: Set<string>;
  messageCount: number;
  rawReferences: RawReference[];
  createdAt: number;
  updatedAt: number;
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
  messageOwners: Map<string, string[]>;
  rawReferences: RawReference[];
}

interface HistoryFacts {
  sessions: Map<string, SessionFact>;
  rawReferences: RawReference[];
}

interface RunFacts {
  runIds: Set<string>;
  terminalRunIds: Set<string>;
  locallyCommittedRunIds: Set<string>;
}

interface NativeFacts {
  records: NativeExecutionRecord[];
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

  const [data, conversations, history, runs, native] = await Promise.all([
    scanDataJson(context),
    scanConversations(context),
    scanHistory(context),
    scanHarnessRuns(context),
    scanNativeStore(context)
  ]);
  const relations: StorageInventoryRelation[] = [];
  const findings = [
    ...data.accumulator.findings,
    ...conversations.accumulator.findings,
    ...history.accumulator.findings,
    ...runs.accumulator.findings,
    ...native.accumulator.findings
  ];

  correlateDataAndConversations(data.facts, conversations.facts, relations, findings);
  correlateHistoryAndConversations(
    history.facts,
    conversations.facts,
    relations
  );
  correlateNativeRecords(
    native.facts,
    runs.facts,
    conversations.facts,
    relations,
    findings
  );

  const raw = await scanRawMetadata(context, [
    ...data.facts.rawReferences,
    ...conversations.facts.rawReferences,
    ...history.facts.rawReferences
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
  for (const [index, value] of sessions.entries()) {
    const session = objectRecord(value);
    if (!session || typeof session.id !== "string" || !session.id) {
      accumulator.addCorrupt("data-session-invalid", `session:${index}`);
      continue;
    }
    const sessionId = session.id;
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
      messageCount: messageFacts.length,
      rawReferences,
      createdAt: timestampOrZero(session.createdAt),
      updatedAt: timestampOrZero(session.updatedAt)
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
    messageOwners: new Map(),
    rawReferences: []
  };
  const root = path.join(context.pluginRoot, "conversations");
  const rootEntries = await listDirectory(context, accumulator, root, false);
  if (!rootEntries) {
    accumulator.markUnavailable("conversation-store-unavailable");
    accumulator.missingCount += 1;
    return { accumulator, facts };
  }

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
    const sessionDir = path.join(sessionsRoot, directoryName);
    const stats = await safeLstat(context, accumulator, sessionDir, false);
    if (!stats || !stats.isDirectory()) continue;
    const metadataPath = path.join(sessionDir, "metadata.json");
    const messagesPath = path.join(sessionDir, "messages.jsonl");
    const snapshotsPath = path.join(sessionDir, "snapshots.jsonl");
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
    if (
      typeof metadata?.id === "string"
      && metadata.id
      && sanitizeConversationPathPart(metadata.id) !== directoryName
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
    const messageRows = await readJsonlFile(
      context,
      accumulator,
      messagesPath,
      "conversation-messages-corrupt",
      false
    );
    // Snapshots are parsed for structural integrity only. No body enters facts.
    const snapshotRows = await readJsonlFile(
      context,
      accumulator,
      snapshotsPath,
      "conversation-snapshots-corrupt",
      true
    );
    snapshotRows.forEach((snapshot, index) => {
      accumulator.observeRecordMetadata("conversation-snapshot", {
        sessionId,
        index,
        metadata: snapshotMetadataProjection(snapshot)
      });
    });
    const messageFacts = collectMessageFacts(
      messageRows,
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
      messageCount: messageFacts.length,
      rawReferences,
      createdAt: timestampOrZero(metadata?.createdAt),
      updatedAt: timestampOrZero(metadata?.updatedAt)
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
    const directoryName = sanitizeConversationPathPart(summary.sessionId);
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
  accumulator.recordCount = facts.sessions.size;
  accumulator.incrementMetric("session-count", facts.sessions.size);
  accumulator.relations.push(...[]);
  return { accumulator, facts };
}

async function scanHistory(context: ScanContext): Promise<SourceScan<HistoryFacts>> {
  const accumulator = new SourceAccumulator("history", context.pluginRoot);
  const facts: HistoryFacts = {
    sessions: new Map(),
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
    const sessionRawRefs: RawReference[] = [];
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
        if (message.rawRef) {
          sessionRawRefs.push({
            sourceId: "history",
            ownerRef: opaque("history-message", `${owner}:${message.id}`),
            rawRef: message.rawRef
          });
        }
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
    facts.sessions.set(sessionId, {
      id: sessionId,
      messageIds: new Set(allMessages.map((message) => message.id)),
      messageCount: allMessages.length,
      rawReferences: sessionRawRefs,
      createdAt: minimumPositive(allMessages.map((message) => message.createdAt)),
      updatedAt: maximumPositive(allMessages.map((message) => message.createdAt))
    });
    facts.rawReferences.push(...sessionRawRefs);
    accumulator.incrementMetric("day-count", dayMap.size);
    accumulator.incrementMetric("message-count", allMessages.length);
    accumulator.incrementMetric("raw-reference-count", sessionRawRefs.length);
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
  return { accumulator, facts };
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
  }
  if (index) {
    const version = finiteInteger(index.version);
    accumulator.schemaVersion = version === null ? null : String(version);
    accumulator.observeRecordMetadata("native-index", {
      version,
      updatedAt: finiteTimestamp(index.updatedAt)
    });
    if (version !== null && version > CURRENT_NATIVE_SCHEMA) {
      accumulator.futureSchemaCount += 1;
      accumulator.markPartial("future-schema");
      accumulator.addFinding({
        code: "future-schema",
        category: "future-schema",
        severity: "blocking",
        recordRaw: "native-index",
        blocksMigration: true
      });
    }
    const records = Array.isArray(index.records) ? index.records : [];
    const indexedRecordIds = new Set<string>();
    for (const [indexPosition, value] of records.entries()) {
      if (!isNativeExecutionRecord(value)) {
        accumulator.addCorrupt("native-record-invalid", `record:${indexPosition}`);
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
      if (value.cleanup === "pending" || value.cleanup === "failed") {
        accumulator.addFinding({
          code: "cleanup-pending",
          category: "cleanup-pending",
          severity: "warning",
          recordRaw: value.id,
          metadata: [
            { name: "attempt-count", value: nonNegativeInteger(value.attempts) }
          ],
          blocksMigration: false
        });
        accumulator.incrementMetric("cleanup-backlog-count");
      }
      if (value.cleanup === "failed" && value.attempts >= 6) {
        accumulator.addFinding({
          code: "quarantined-candidate",
          category: "quarantined-candidate",
          severity: "warning",
          recordRaw: value.id,
          metadata: [
            { name: "attempt-count", value: nonNegativeInteger(value.attempts) }
          ],
          blocksMigration: false
        });
      }
    }
  }

  const eventRows = await readJsonlFile(
    context,
    accumulator,
    eventsPath,
    "native-events-corrupt",
    true
  );
  eventRows.forEach((value) => {
    const event = objectRecord(value);
    if (!event) return;
    if (event.type === "upsert" && isNativeExecutionRecord(event.record)) {
      accumulator.observeRecordMetadata("native-event", {
        type: "upsert",
        createdAt: finiteTimestamp(event.createdAt),
        record: JSON.parse(nativeRecordMetadataKey(event.record)) as unknown
      });
    } else {
      accumulator.observeRecordMetadata("native-event", {
        type: stringOrNull(event.type),
        id: stringOrNull(event.id),
        createdAt: finiteTimestamp(event.createdAt)
      });
    }
  });
  const replayed = replayNativeEvents(eventRows, accumulator);
  const indexed = new Map(facts.records.map((record) => [record.id, record]));
  const unionIds = new Set([...indexed.keys(), ...replayed.keys()]);
  for (const id of unionIds) {
    const left = indexed.get(id);
    const right = replayed.get(id);
    if (!left || !right || nativeRecordMetadataKey(left) !== nativeRecordMetadataKey(right)) {
      accumulator.addFinding({
        code: "native-index-event-drift",
        category: left && right ? "ambiguous" : "missing",
        severity: "blocking",
        recordRaw: id,
        blocksMigration: true
      });
    }
  }
  accumulator.recordCount = facts.records.length;
  accumulator.incrementMetric("native-record-count", facts.records.length);
  return { accumulator, facts };
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
  relations: StorageInventoryRelation[]
): void {
  for (const session of history.sessions.values()) {
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
      status: conversations.sessions.has(session.id) ? "linked" : "unlinked"
    });
    const conversation = conversations.sessions.get(session.id);
    if (!conversation) continue;
    for (const messageId of session.messageIds) {
      if (!conversation.messageIds.has(messageId)) continue;
      relations.push({
        kind: "history-message-projection",
        from: {
          sourceId: "history",
          entityType: "message",
          ref: opaque("history-message", `${session.id}:${messageId}`)
        },
        to: {
          sourceId: "conversations",
          entityType: "message",
          ref: opaque("conversation-message", `${session.id}:${messageId}`)
        },
        status: "linked"
      });
    }
  }
}

function correlateNativeRecords(
  native: NativeFacts,
  runs: RunFacts,
  conversations: ConversationFacts,
  relations: StorageInventoryRelation[],
  findings: StorageInventoryFinding[]
): void {
  for (const record of native.records) {
    const nativeRef = opaque("native-record", record.id);
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

function replayNativeEvents(
  rows: readonly unknown[],
  accumulator: SourceAccumulator
): Map<string, NativeExecutionRecord> {
  const records = new Map<string, NativeExecutionRecord>();
  for (const [index, value] of rows.entries()) {
    const event = objectRecord(value);
    if (!event || (event.type !== "upsert" && event.type !== "remove")) {
      accumulator.addCorrupt("native-event-invalid", `event:${index}`);
      continue;
    }
    if (event.type === "upsert") {
      if (!isNativeExecutionRecord(event.record)) {
        accumulator.addCorrupt("native-event-record-invalid", `event:${index}`);
        continue;
      }
      records.set(event.record.id, event.record);
    } else if (typeof event.id === "string" && event.id) {
      records.delete(event.id);
    } else {
      accumulator.addCorrupt("native-event-id-invalid", `event:${index}`);
    }
  }
  return records;
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
    && isOneOf(record.surface, ["knowledge", "editor", "review", "chat"])
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
      "pending",
      "disposed",
      "unsupported",
      "failed",
      "retained-for-recovery",
      "retained"
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

function sanitizeConversationPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
    || "session";
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
        snapshotVersion: stringOrNull(cursor.snapshotVersion)
      }
      : null,
    vaultProfileFingerprint: stringOrNull(binding.vaultProfileFingerprint),
    lastUsedAt: finiteTimestamp(binding.lastUsedAt)
  };
}

function snapshotMetadataProjection(value: unknown): unknown {
  const snapshot = objectRecord(value);
  if (!snapshot) return null;
  return {
    sessionId: stringOrNull(snapshot.sessionId),
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
