import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import * as path from "node:path";
import { pluginDataDir, rawStorageDir } from "../core/raw-message-store";
import {
  createConversationMessageRevision,
  FileConversationStore,
  validateChatMessage
} from "../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../harness/conversation/conversation-store-v2";
import {
  resolveConversationStoreSelection
} from "../harness/conversation/store-manifest";
import type {
  ConversationCommitV2,
  MessageV2
} from "../harness/contracts/conversation-v2";
import {
  createConversationProductMessageRevision,
  historyMigrationInventoryFromReferences,
  type HistoryMigrationReferenceInput
} from "../harness/lifecycle/conversation-migration-projection";
import {
  publishRecordMigrationConflictQuarantine
} from "../harness/lifecycle/record-migration-conflict-quarantine";
import {
  validateRecordMigration
} from "../harness/lifecycle/record-migration-validator";
import {
  isKnowledgeBaseSession,
  type ChatMessage,
  type CodexForObsidianSettings,
  type StoredSession
} from "../settings/settings";

export const KNOWLEDGE_BASE_HISTORY_VERSION = 2;
export const KNOWLEDGE_BASE_ACTIVE_DAY_MESSAGE_LIMIT = 1000;

const LEGACY_KNOWLEDGE_BASE_HISTORY_VERSION = 1;
const HISTORY_ACTIVE_KIND = "knowledge-history-active";
const HISTORY_GENERATION_KIND = "knowledge-history-generation";
const HISTORY_SUPPRESSIONS_KIND = "knowledge-history-suppressions";
const HISTORY_REFERENCE_KIND = "conversation-message";

export interface KnowledgeBaseHistoryMessageReferenceV2 {
  version: 2;
  kind: "conversation-message";
  conversationId: string;
  messageId: string;
  messageRevision: string;
}

export interface KnowledgeBaseHistoryDaySummary {
  date: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  processMessageCount: number;
  failedMessageCount: number;
  firstMessageAt: number;
  lastMessageAt: number;
}

export interface KnowledgeBaseHistorySessionSummary {
  sessionId: string;
  title: string;
  kind: "knowledge-base";
  activeDate: string;
  messageCount: number;
  dayCount: number;
  updatedAt: number;
  days: KnowledgeBaseHistoryDaySummary[];
}

export interface KnowledgeBaseHistoryIndex {
  version: number;
  updatedAt: number;
  sessions: KnowledgeBaseHistorySessionSummary[];
}

export interface KnowledgeBaseHistoryMigrationSummary {
  version: number;
  migratedAt: number;
  sessionCount: number;
  messageCount: number;
  activeDate: string;
}

export interface KnowledgeBaseStorageStats {
  dataJsonBytes: number;
  historyBytes: number;
  rawBytes: number;
  sessionCount: number;
  dayCount: number;
  messageCount: number;
}

export interface KnowledgeBaseHistoryMutationResult {
  changed: boolean;
  messageCount: number;
  activeDate: string;
}

export interface KnowledgeBaseHistoryRemovalResult {
  removedDayCount: number;
  removedMessageCount: number;
}

export interface KnowledgeBaseHistoryPublishHooks {
  afterGenerationStaged?: (generationId: string) => void | Promise<void>;
  beforeSourceRevalidation?: (
    generationId: string
  ) => void | Promise<void>;
  beforeActivePublish?: (generationId: string) => void | Promise<void>;
}

export interface KnowledgeBaseHistoryRebuildOptions {
  retentionDays?: number;
  now?: number;
  restoreSuppressed?: boolean;
  hooks?: KnowledgeBaseHistoryPublishHooks;
}

export interface KnowledgeBaseHistoryMigrationOptions {
  allowLegacyCutover?: boolean;
}

export interface KnowledgeBaseHistoryActiveV2 {
  version: 2;
  kind: "knowledge-history-active";
  generationId: string;
  generationRevision: string;
  sourceRevision: string;
  suppressionRevision: string;
  publishedAt: number;
}

export interface KnowledgeBaseHistorySuppressionV2 {
  version: 2;
  conversationId: string;
  messageId: string;
  messageRevision: string;
  date: string;
  suppressedAt: number;
  reason: "user-delete";
}

export interface KnowledgeBaseHistorySuppressionsV2 {
  version: 2;
  kind: "knowledge-history-suppressions";
  revision: string;
  updatedAt: number;
  entries: KnowledgeBaseHistorySuppressionV2[];
}

export interface KnowledgeBaseHistoryGenerationFileV2 {
  relativePath: string;
  digest: string;
  rowCount: number;
}

export interface KnowledgeBaseHistoryGenerationV2 {
  version: 2;
  kind: "knowledge-history-generation";
  generationId: string;
  createdAt: number;
  sourceRevision: string;
  suppressionRevision: string;
  retentionDays: number | null;
  retentionCutoffDate: string | null;
  indexRevision: string;
  projectionRevision: string;
  sessionCount: number;
  dayCount: number;
  messageCount: number;
  files: KnowledgeBaseHistoryGenerationFileV2[];
}

interface KnowledgeBaseHistoryProjectionV2 {
  active: KnowledgeBaseHistoryActiveV2;
  generation: KnowledgeBaseHistoryGenerationV2;
  suppressions: KnowledgeBaseHistorySuppressionsV2;
  index: KnowledgeBaseHistoryIndex;
  generationRoot: string;
}

interface KnowledgeBaseHistorySource {
  sessions: StoredSession[];
  revision: string;
}

interface LegacyKnowledgeBaseHistoryProjectionV1 {
  references: HistoryMigrationReferenceInput[];
  selectedMessageKeys: Set<string>;
}

interface PublishKnowledgeBaseHistoryOptions {
  retentionDays?: number;
  now: number;
  force?: boolean;
  allowLegacyCutover?: boolean;
  suppressions?: KnowledgeBaseHistorySuppressionV2[];
  restoreSuppressed?: boolean;
  hooks?: KnowledgeBaseHistoryPublishHooks;
}

interface PublishKnowledgeBaseHistoryResult {
  changed: boolean;
  source: KnowledgeBaseHistorySource;
  index: KnowledgeBaseHistoryIndex;
  active: KnowledgeBaseHistoryActiveV2;
}

const historyWriterTails = new Map<string, Promise<void>>();

export class KnowledgeBaseHistoryMigrationRequiredError extends Error {
  readonly code = "knowledge_history_migration_required";

  constructor() {
    super(
      "Knowledge History V2 cutover requires an explicit validated migration"
    );
    this.name = "KnowledgeBaseHistoryMigrationRequiredError";
  }
}

export function knowledgeBaseHistoryRoot(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(pluginDataDir(vaultPath, pluginDir), "history");
}

/**
 * Legacy V1 index path. V2 never overwrites this file.
 */
export function knowledgeBaseHistoryIndexPath(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(knowledgeBaseHistoryRoot(vaultPath, pluginDir), "index.json");
}

/**
 * Legacy V1 migration receipt path. V2 uses its own side-by-side receipt.
 */
export function knowledgeBaseHistoryMigrationPath(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(
    knowledgeBaseHistoryRoot(vaultPath, pluginDir),
    "migration.json"
  );
}

/**
 * Legacy V1 day path. V2 generation paths are resolved through active.json.
 */
export function knowledgeBaseHistoryDayPath(
  vaultPath: string,
  pluginDir: string,
  sessionId: string,
  date: string
): string {
  return path.join(
    knowledgeBaseHistoryRoot(vaultPath, pluginDir),
    "sessions",
    sanitizeHistoryPathPart(sessionId),
    `${sanitizeHistoryPathPart(date)}.jsonl`
  );
}

export function knowledgeBaseHistoryV2Root(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(knowledgeBaseHistoryRoot(vaultPath, pluginDir), "v2");
}

export function knowledgeBaseHistoryActivePath(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(knowledgeBaseHistoryV2Root(vaultPath, pluginDir), "active.json");
}

export function knowledgeBaseHistorySuppressionsPath(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(
    knowledgeBaseHistoryV2Root(vaultPath, pluginDir),
    "suppressions.json"
  );
}

export function knowledgeBaseHistoryV2MigrationPath(
  vaultPath: string,
  pluginDir: string
): string {
  return path.join(
    knowledgeBaseHistoryV2Root(vaultPath, pluginDir),
    "migration.json"
  );
}

export function knowledgeBaseHistoryGenerationRoot(
  vaultPath: string,
  pluginDir: string,
  generationId: string
): string {
  assertSafeHistoryPathPart(generationId, "generation ID");
  return path.join(
    knowledgeBaseHistoryV2Root(vaultPath, pluginDir),
    "generations",
    generationId
  );
}

export function knowledgeBaseHistoryGenerationDayPath(
  vaultPath: string,
  pluginDir: string,
  generationId: string,
  sessionId: string,
  date: string
): string {
  return path.join(
    knowledgeBaseHistoryGenerationRoot(vaultPath, pluginDir, generationId),
    historyDayRelativePath(sessionId, date)
  );
}

export function localDateKeyForTimestamp(value: number): string {
  const date = new Date(
    Number.isFinite(value) && value > 0 ? value : Date.now()
  );
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function latestKnowledgeBaseMessageDate(
  messages: ChatMessage[]
): string {
  let latest = 0;
  for (const message of messages) {
    if ((message.createdAt || 0) > latest) latest = message.createdAt || 0;
  }
  return latest ? localDateKeyForTimestamp(latest) : "";
}

export function activeKnowledgeBaseHistoryDate(
  messages: ChatMessage[],
  currentActiveDate = "",
  now = Date.now()
): string {
  const dates = sortedKnowledgeBaseMessageDates(messages);
  if (!dates.length) return "";
  const today = localDateKeyForTimestamp(now);
  const latestBeforeToday =
    [...dates].filter((date) => date < today).at(-1) ?? "";
  if (latestBeforeToday) {
    if (
      currentActiveDate
      && currentActiveDate < today
      && dates.includes(currentActiveDate)
      && currentActiveDate >= latestBeforeToday
    ) {
      return currentActiveDate;
    }
    return latestBeforeToday;
  }
  return dates.at(-1) ?? "";
}

export function activeKnowledgeBaseMessageDates(
  messages: ChatMessage[],
  currentActiveDate = "",
  now = Date.now()
): Set<string> {
  const dates = new Set(sortedKnowledgeBaseMessageDates(messages));
  const activeDate = activeKnowledgeBaseHistoryDate(
    messages,
    currentActiveDate,
    now
  );
  const today = localDateKeyForTimestamp(now);
  const activeDates = new Set<string>();
  if (activeDate) activeDates.add(activeDate);
  if (dates.has(today)) activeDates.add(today);
  if (!activeDates.size && dates.size) {
    activeDates.add([...dates].at(-1) ?? "");
  }
  activeDates.delete("");
  return activeDates;
}

export function filterKnowledgeBaseMessagesForDate(
  messages: ChatMessage[],
  date: string
): ChatMessage[] {
  if (!date) return [];
  return messages.filter(
    (message) => localDateKeyForTimestamp(message.createdAt) === date
  );
}

/**
 * Compatibility API: History V2 never truncates canonical Conversation
 * messages. It only maintains the lightweight active-date UI projection.
 */
export function compactKnowledgeBaseMessagesToActiveDay(
  session: StoredSession,
  now = Date.now()
): boolean {
  const activeDate = activeKnowledgeBaseHistoryDate(
    session.messages,
    session.historyActiveDate,
    now
  );
  const changed = activeDate !== (session.historyActiveDate ?? "");
  session.historyActiveDate = activeDate || undefined;
  return changed;
}

export async function migrateKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string,
  settings: CodexForObsidianSettings,
  options: KnowledgeBaseHistoryMigrationOptions = {}
): Promise<KnowledgeBaseHistoryMutationResult> {
  const session = settings.sessions.find((item) =>
    isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId)
  );
  if (!session) {
    return { changed: false, messageCount: 0, activeDate: "" };
  }
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    if (
      !options.allowLegacyCutover
      && await requiresExplicitLegacyCutover(vaultPath, pluginDir)
    ) {
      const activeDate = activeKnowledgeBaseHistoryDate(
        session.messages,
        session.historyActiveDate
      );
      const changed = activeDate !== (session.historyActiveDate ?? "");
      session.historyActiveDate = activeDate || undefined;
      return {
        changed,
        messageCount: session.messages.length,
        activeDate
      };
    }
    const result = await publishKnowledgeBaseHistoryUnlocked(
      vaultPath,
      pluginDir,
      {
        retentionDays: settings.knowledgeBase.historyRetentionDays,
        now: Date.now(),
        allowLegacyCutover: options.allowLegacyCutover
      }
    );
    const canonicalSession = result.source.sessions.find(
      (item) => item.id === session.id
    );
    const activeDate = activeKnowledgeBaseHistoryDate(
      canonicalSession?.messages ?? session.messages,
      canonicalSession?.historyActiveDate ?? session.historyActiveDate
    );
    const activeDateChanged =
      activeDate !== (session.historyActiveDate ?? "");
    session.historyActiveDate = activeDate || undefined;

    const receiptPath = knowledgeBaseHistoryV2MigrationPath(
      vaultPath,
      pluginDir
    );
    const receiptExists = await fileExists(receiptPath);
    if (!receiptExists) {
      const summary: KnowledgeBaseHistoryMigrationSummary = {
        version: KNOWLEDGE_BASE_HISTORY_VERSION,
        migratedAt: Date.now(),
        sessionCount: result.index.sessions.length,
        messageCount: result.index.sessions.reduce(
          (sum, item) => sum + item.messageCount,
          0
        ),
        activeDate
      };
      await writeJsonAtomic(receiptPath, summary);
    }
    return {
      changed: result.changed || activeDateChanged || !receiptExists,
      messageCount: canonicalSession?.messages.length ?? 0,
      activeDate
    };
  });
}

export async function persistAndCompactKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string,
  settings: CodexForObsidianSettings,
  now = Date.now()
): Promise<KnowledgeBaseHistoryMutationResult> {
  const session = settings.sessions.find((item) =>
    isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId)
  );
  if (!session) {
    return { changed: false, messageCount: 0, activeDate: "" };
  }
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    if (await requiresExplicitLegacyCutover(vaultPath, pluginDir)) {
      const activeDate = activeKnowledgeBaseHistoryDate(
        session.messages,
        session.historyActiveDate,
        now
      );
      const changed = activeDate !== (session.historyActiveDate ?? "");
      session.historyActiveDate = activeDate || undefined;
      return {
        changed,
        messageCount: session.messages.length,
        activeDate
      };
    }
    const result = await publishKnowledgeBaseHistoryUnlocked(
      vaultPath,
      pluginDir,
      {
        retentionDays: settings.knowledgeBase.historyRetentionDays,
        now
      }
    );
    const canonicalSession = result.source.sessions.find(
      (item) => item.id === session.id
    );
    const activeDate = activeKnowledgeBaseHistoryDate(
      canonicalSession?.messages ?? session.messages,
      canonicalSession?.historyActiveDate ?? session.historyActiveDate,
      now
    );
    const activeDateChanged =
      activeDate !== (session.historyActiveDate ?? "");
    session.historyActiveDate = activeDate || undefined;
    return {
      changed: result.changed || activeDateChanged,
      messageCount: canonicalSession?.messages.length ?? 0,
      activeDate
    };
  });
}

export async function persistKnowledgeBaseHistoryMessages(
  vaultPath: string,
  pluginDir: string,
  session: StoredSession,
  messages: ChatMessage[]
): Promise<void> {
  if (session.kind !== "knowledge-base") {
    throw new Error(
      `Knowledge History recovery required: Conversation ${session.id} is not knowledge-base`
    );
  }
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  await withHistoryWriterLane(root, async () => {
    const source = await readStableKnowledgeBaseHistorySource(
      vaultPath,
      pluginDir
    );
    const canonical = source.sessions.find((item) => item.id === session.id);
    if (!canonical) {
      throw new Error(
        `Knowledge History recovery required: canonical Conversation ${session.id} is unavailable`
      );
    }
    const canonicalById = uniqueCanonicalMessages(canonical);
    for (const message of messages) {
      validateChatMessage(message);
      const durable = canonicalById.get(message.id);
      if (
        !durable
        || createConversationMessageRevision(durable)
          !== createConversationMessageRevision(message)
      ) {
        throw new Error(
          `Knowledge History recovery required: canonical message conflict ${message.id}`
        );
      }
    }
    await publishKnowledgeBaseHistoryUnlocked(
      vaultPath,
      pluginDir,
      { now: Date.now() },
      source
    );
  });
}

export async function readKnowledgeBaseHistoryActive(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistoryActiveV2 | null> {
  return await readHistoryActive(
    knowledgeBaseHistoryActivePath(vaultPath, pluginDir)
  );
}

export async function readKnowledgeBaseHistoryIndex(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistoryIndex> {
  const projection = await readActiveProjectionMetadata(vaultPath, pluginDir);
  if (projection) return structuredClone(projection.index);
  return await readLegacyKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
}

export async function readKnowledgeBaseHistoryDay(
  vaultPath: string,
  pluginDir: string,
  sessionId: string,
  date: string
): Promise<ChatMessage[]> {
  const projection = await readActiveProjectionMetadata(vaultPath, pluginDir);
  if (!projection) {
    return await readLegacyKnowledgeBaseHistoryDay(
      vaultPath,
      pluginDir,
      sessionId,
      date
    );
  }
  const sessionSummary = projection.index.sessions.find(
    (session) => session.sessionId === sessionId
  );
  const daySummary = sessionSummary?.days.find((day) => day.date === date);
  if (!daySummary) {
    throw new Error(
      `Knowledge History recovery required: active generation does not index ${sessionId}/${date}`
    );
  }
  const references = await readGenerationReferences(
    projection,
    sessionId,
    date
  );
  const canonical = await readCanonicalKnowledgeConversation(
    vaultPath,
    pluginDir,
    sessionId
  );
  const canonicalById = uniqueCanonicalMessages(canonical);
  assertHistoryReferencesMatchCanonical(
    references,
    canonicalById,
    date,
    sessionId
  );
  const messages = references.map((reference) =>
    structuredClone(canonicalById.get(reference.messageId)!)
  );
  assertDaySummaryMatchesMessages(daySummary, messages);
  return messages;
}

export async function rebuildKnowledgeBaseHistoryIndex(
  vaultPath: string,
  pluginDir: string,
  options: KnowledgeBaseHistoryRebuildOptions = {}
): Promise<KnowledgeBaseHistoryIndex> {
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    const result = await publishKnowledgeBaseHistoryUnlocked(
      vaultPath,
      pluginDir,
      {
        retentionDays: options.retentionDays,
        now: options.now ?? Date.now(),
        force: true,
        restoreSuppressed: options.restoreSuppressed,
        hooks: options.hooks
      }
    );
    return structuredClone(result.index);
  });
}

export async function collectKnowledgeBaseStorageStats(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseStorageStats> {
  const dataJson = path.join(
    pluginDataDir(vaultPath, pluginDir),
    "data.json"
  );
  const [dataJsonBytes, historyBytes, rawBytes, index] = await Promise.all([
    fileSize(dataJson),
    directorySize(knowledgeBaseHistoryRoot(vaultPath, pluginDir)),
    directorySize(rawStorageDir(vaultPath, pluginDir)),
    readKnowledgeBaseHistoryIndex(vaultPath, pluginDir)
  ]);
  const sessionCount = index.sessions.length;
  const dayCount = index.sessions.reduce(
    (sum, session) => sum + session.dayCount,
    0
  );
  const messageCount = index.sessions.reduce(
    (sum, session) => sum + session.messageCount,
    0
  );
  return {
    dataJsonBytes,
    historyBytes,
    rawBytes,
    sessionCount,
    dayCount,
    messageCount
  };
}

export async function exportKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string,
  outputDir = "outputs"
): Promise<string> {
  const activeBefore = await readActiveProjectionMetadata(
    vaultPath,
    pluginDir
  );
  const index = activeBefore?.index
    ?? await readLegacyKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const sourceBefore = activeBefore
    ? await readStableKnowledgeBaseHistorySource(vaultPath, pluginDir)
    : null;
  const canonicalBySession = sourceBefore
    ? new Map(
      sourceBefore.sessions.map(
        (session) => [session.id, uniqueCanonicalMessages(session)] as const
      )
    )
    : null;
  const sessions: Array<
    Omit<KnowledgeBaseHistorySessionSummary, "days"> & {
      days: Array<
        KnowledgeBaseHistoryDaySummary & { messages: ChatMessage[] }
      >;
    }
  > = [];
  for (const session of index.sessions) {
    const days: Array<
      KnowledgeBaseHistoryDaySummary & { messages: ChatMessage[] }
    > = [];
    for (const day of session.days) {
      let messages: ChatMessage[];
      if (activeBefore && canonicalBySession) {
        const references = await readGenerationReferences(
          activeBefore,
          session.sessionId,
          day.date
        );
        const canonical = canonicalBySession.get(session.sessionId);
        if (!canonical) {
          throw new Error(
            `Knowledge History export blocked: canonical Conversation ${session.sessionId} is unavailable`
          );
        }
        assertHistoryReferencesMatchCanonical(
          references,
          canonical,
          day.date,
          session.sessionId
        );
        messages = references.map((reference) =>
          structuredClone(canonical.get(reference.messageId)!)
        );
        assertDaySummaryMatchesMessages(day, messages);
      } else {
        messages = await readLegacyKnowledgeBaseHistoryDay(
          vaultPath,
          pluginDir,
          session.sessionId,
          day.date
        );
        assertDaySummaryMatchesMessages(day, messages);
      }
      days.push({ ...day, messages });
    }
    sessions.push({ ...session, days });
  }

  if (activeBefore && sourceBefore) {
    const sourceAfter = await readKnowledgeBaseHistorySource(
      vaultPath,
      pluginDir
    );
    const activeAfter = await readHistoryActive(
      knowledgeBaseHistoryActivePath(vaultPath, pluginDir)
    );
    if (
      sourceAfter.revision !== sourceBefore.revision
      || activeAfter?.generationId !== activeBefore.active.generationId
      || activeAfter.generationRevision
        !== activeBefore.active.generationRevision
    ) {
      throw new Error(
        "Knowledge History export blocked: source or active generation changed during export"
      );
    }
  }

  const relative =
    `${outputDir.replace(/^\/+|\/+$/g, "")}`
    + `/codex-echoink-history-export-${localDateKeyForTimestamp(Date.now())}`
    + `-${Date.now()}.json`;
  const absolute = path.join(vaultPath, relative);
  await writeJsonAtomic(absolute, {
    version: index.version,
    exportedAt: Date.now(),
    sessions
  });
  return relative.replace(/\\/g, "/");
}

/**
 * History V2 rows contain references only. Process-message compaction belongs
 * to a future Conversation retention policy and cannot be reported as a
 * History mutation.
 */
export async function compactOldKnowledgeBaseProcessHistory(
  vaultPath: string,
  pluginDir: string,
  activeDate = localDateKeyForTimestamp(Date.now())
): Promise<number> {
  void vaultPath;
  void pluginDir;
  void activeDate;
  return 0;
}

export async function removeKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistoryRemovalResult> {
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    const source = await readStableKnowledgeBaseHistorySource(
      vaultPath,
      pluginDir
    );
    const current = await ensureActiveProjectionUnlocked(
      vaultPath,
      pluginDir,
      source
    );
    const removedDayCount = current.index.sessions.reduce(
      (sum, session) => sum + session.dayCount,
      0
    );
    const removedMessageCount = current.index.sessions.reduce(
      (sum, session) => sum + session.messageCount,
      0
    );
    const entries = mergeSuppressionEntries(
      current.suppressions.entries,
      source.sessions.flatMap((session) =>
        session.messages.map((message) =>
          suppressionForMessage(session.id, message, Date.now())
        )
      )
    );
    await publishKnowledgeBaseHistoryUnlocked(
      vaultPath,
      pluginDir,
      {
        now: Date.now(),
        force: true,
        suppressions: entries
      },
      source
    );
    return { removedDayCount, removedMessageCount };
  });
}

export async function removeKnowledgeBaseHistoryDays(
  vaultPath: string,
  pluginDir: string,
  dates: string[],
  sessionId?: string
): Promise<KnowledgeBaseHistoryRemovalResult> {
  const targets = new Set(
    dates.map((date) => date.trim()).filter(isHistoryDateKey)
  );
  if (!targets.size) {
    return { removedDayCount: 0, removedMessageCount: 0 };
  }
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    const source = await readStableKnowledgeBaseHistorySource(
      vaultPath,
      pluginDir
    );
    const current = await ensureActiveProjectionUnlocked(
      vaultPath,
      pluginDir,
      source
    );
    const targetSessions = sessionId
      ? current.index.sessions.filter(
        (session) => session.sessionId === sessionId
      )
      : current.index.sessions;
    const selectedDays = targetSessions.flatMap((session) =>
      session.days
        .filter((day) => targets.has(day.date))
        .map((day) => ({ sessionId: session.sessionId, day }))
    );
    const selectedSessionDates = new Set(
      selectedDays.map(
        ({ sessionId: selectedId, day }) => `${selectedId}\0${day.date}`
      )
    );
    const entries = mergeSuppressionEntries(
      current.suppressions.entries,
      source.sessions.flatMap((session) =>
        session.messages
          .filter((message) =>
            selectedSessionDates.has(
              `${session.id}\0${localDateKeyForTimestamp(message.createdAt)}`
            )
          )
          .map((message) =>
            suppressionForMessage(session.id, message, Date.now())
          )
      )
    );
    if (selectedDays.length) {
      await publishKnowledgeBaseHistoryUnlocked(
        vaultPath,
        pluginDir,
        {
          now: Date.now(),
          force: true,
          suppressions: entries
        },
        source
      );
    }
    return {
      removedDayCount: selectedDays.length,
      removedMessageCount: selectedDays.reduce(
        (sum, item) => sum + item.day.messageCount,
        0
      )
    };
  });
}

export async function pruneKnowledgeBaseHistoryByRetention(
  vaultPath: string,
  pluginDir: string,
  retentionDays: number,
  now = Date.now()
): Promise<KnowledgeBaseHistoryRemovalResult> {
  const normalizedRetention = normalizeRetentionDays(retentionDays);
  if (normalizedRetention === null) {
    return { removedDayCount: 0, removedMessageCount: 0 };
  }
  const cutoff = retentionCutoffDate(normalizedRetention, now)!;
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  return await withHistoryWriterLane(root, async () => {
    const before = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
    const expiredDays = before.sessions.flatMap((session) =>
      session.days
        .filter((day) => day.date < cutoff)
        .map((day) => ({ sessionId: session.sessionId, day }))
    );
    await publishKnowledgeBaseHistoryUnlocked(vaultPath, pluginDir, {
      retentionDays: normalizedRetention,
      now,
      force: true
    });
    return {
      removedDayCount: expiredDays.length,
      removedMessageCount: expiredDays.reduce(
        (sum, item) => sum + item.day.messageCount,
        0
      )
    };
  });
}

export function parseKnowledgeBaseHistoryMessageReferenceV2(
  value: unknown
): KnowledgeBaseHistoryMessageReferenceV2 {
  const record = requireRecord(value, "History reference");
  assertExactKeys(
    record,
    [
      "version",
      "kind",
      "conversationId",
      "messageId",
      "messageRevision"
    ],
    "History reference"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || record.kind !== HISTORY_REFERENCE_KIND
    || typeof record.conversationId !== "string"
    || !record.conversationId.trim()
    || typeof record.messageId !== "string"
    || !record.messageId.trim()
    || !isSha256Revision(record.messageRevision)
  ) {
    throw new Error("History reference schema is invalid");
  }
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_REFERENCE_KIND,
    conversationId: record.conversationId,
    messageId: record.messageId,
    messageRevision: record.messageRevision
  };
}

async function publishKnowledgeBaseHistoryUnlocked(
  vaultPath: string,
  pluginDir: string,
  options: PublishKnowledgeBaseHistoryOptions,
  preparedSource?: KnowledgeBaseHistorySource
): Promise<PublishKnowledgeBaseHistoryResult> {
  const source = preparedSource
    ?? await readStableKnowledgeBaseHistorySource(vaultPath, pluginDir);
  const current = await readActiveProjectionMetadata(vaultPath, pluginDir);
  const legacyCutoverRequired = !current
    && await requiresExplicitLegacyCutover(vaultPath, pluginDir);
  let legacyProjection: LegacyKnowledgeBaseHistoryProjectionV1 | null = null;
  if (!current) {
    if (
      !options.allowLegacyCutover
      && legacyCutoverRequired
    ) {
      throw new KnowledgeBaseHistoryMigrationRequiredError();
    }
    legacyProjection = await readLegacyV1ProjectionForMigration(
      vaultPath,
      pluginDir
    );
  } else {
    await validateGenerationDirectory(
      current.generationRoot,
      current.generation,
      current.index,
      current.suppressions,
      source
    );
  }
  const retentionDays = legacyCutoverRequired
    ? null
    : normalizeRetentionDays(options.retentionDays);
  const cutoff = retentionCutoffDate(retentionDays, options.now);
  const suppressionEntries = legacyCutoverRequired
    ? []
    : options.restoreSuppressed
    ? []
    : normalizeSuppressionEntries(
      options.suppressions ?? current?.suppressions.entries ?? []
    );
  const suppressions = createSuppressions(
    suppressionEntries,
    options.now
  );
  if (
    !options.force
    && current
    && current.active.sourceRevision === source.revision
    && current.generation.retentionDays === retentionDays
    && current.generation.retentionCutoffDate === cutoff
    && current.suppressions.revision === suppressions.revision
  ) {
    return {
      changed: false,
      source,
      index: structuredClone(current.index),
      active: structuredClone(current.active)
    };
  }

  const generationId = createGenerationId(options.now);
  const v2Root = knowledgeBaseHistoryV2Root(vaultPath, pluginDir);
  const stagingRoot = path.join(v2Root, "staging", generationId);
  const generationRoot = knowledgeBaseHistoryGenerationRoot(
    vaultPath,
    pluginDir,
    generationId
  );
  await mkdir(path.dirname(stagingRoot), { recursive: true });
  await mkdir(stagingRoot, { recursive: false });
  let promoted = false;
  try {
    const projection = buildProjection(
      source,
      suppressions,
      retentionDays,
      cutoff,
      options.now,
      legacyCutoverRequired
        ? legacyProjection?.selectedMessageKeys
        : undefined
    );
    const files: KnowledgeBaseHistoryGenerationFileV2[] = [];
    for (const day of projection.days) {
      const relativePath = historyDayRelativePath(
        day.sessionId,
        day.date
      );
      const text = jsonlText(day.references);
      await writeTextAtomic(path.join(stagingRoot, relativePath), text);
      files.push({
        relativePath,
        digest: sha256Text(text),
        rowCount: day.references.length
      });
    }
    files.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );
    await writeJsonAtomic(
      path.join(stagingRoot, "index.json"),
      projection.index
    );
    await writeJsonAtomic(
      path.join(stagingRoot, "suppressions.json"),
      suppressions
    );
    const generation = createGenerationManifest({
      generationId,
      createdAt: options.now,
      sourceRevision: source.revision,
      suppressions,
      retentionDays,
      retentionCutoffDate: cutoff,
      index: projection.index,
      files
    });
    await writeJsonAtomic(
      path.join(stagingRoot, "manifest.json"),
      generation
    );

    await validateGenerationDirectory(
      stagingRoot,
      generation,
      projection.index,
      suppressions,
      source
    );
    await options.hooks?.afterGenerationStaged?.(generationId);
    await options.hooks?.beforeSourceRevalidation?.(generationId);
    const sourceAfter = await readKnowledgeBaseHistorySource(
      vaultPath,
      pluginDir
    );
    if (sourceAfter.revision !== source.revision) {
      throw new Error(
        "Knowledge History publication blocked: canonical Conversation changed during generation build"
      );
    }
    if (legacyCutoverRequired) {
      const sourceInventory = historyMigrationInventoryFromReferences(
        "v1",
        legacyProjection?.references ?? []
      );
      const targetInventory = historyMigrationInventoryFromReferences(
        "v2",
        historyMigrationReferencesFromProjection(projection)
      );
      const validation = validateRecordMigration(
        sourceInventory,
        targetInventory
      );
      if (!validation.proof || validation.report.status !== "ready") {
        if (validation.report.quarantine) {
          await publishRecordMigrationConflictQuarantine({
            rootPath: path.join(
              knowledgeBaseHistoryV2Root(vaultPath, pluginDir),
              "migration-conflicts"
            ),
            quarantine: validation.report.quarantine
          });
        }
        throw new Error(
          "Knowledge History migration blocked by full subject validation "
          + validation.report.digest
        );
      }
    }

    await mkdir(path.dirname(generationRoot), { recursive: true });
    await rename(stagingRoot, generationRoot);
    promoted = true;
    await options.hooks?.beforeActivePublish?.(generationId);
    const active = createActiveManifest(generation);
    await writeJsonAtomic(
      knowledgeBaseHistorySuppressionsPath(vaultPath, pluginDir),
      suppressions
    );
    await writeJsonAtomic(
      knowledgeBaseHistoryActivePath(vaultPath, pluginDir),
      active
    );
    const readback = await readActiveProjectionMetadata(
      vaultPath,
      pluginDir
    );
    if (
      !readback
      || readback.active.generationId !== generationId
      || readback.active.generationRevision
        !== active.generationRevision
    ) {
      throw new Error(
        "Knowledge History publication blocked: active generation readback failed"
      );
    }
    return {
      changed: true,
      source,
      index: structuredClone(projection.index),
      active
    };
  } catch (error) {
    if (!promoted) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
    throw error;
  }
}

async function ensureActiveProjectionUnlocked(
  vaultPath: string,
  pluginDir: string,
  source: KnowledgeBaseHistorySource
): Promise<KnowledgeBaseHistoryProjectionV2> {
  const active = await readActiveProjectionMetadata(vaultPath, pluginDir);
  if (active) return active;
  await publishKnowledgeBaseHistoryUnlocked(
    vaultPath,
    pluginDir,
    { now: Date.now(), force: true },
    source
  );
  const published = await readActiveProjectionMetadata(vaultPath, pluginDir);
  if (!published) {
    throw new Error(
      "Knowledge History recovery required: V2 active generation was not published"
    );
  }
  return published;
}

async function readActiveProjectionMetadata(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistoryProjectionV2 | null> {
  const active = await readHistoryActive(
    knowledgeBaseHistoryActivePath(vaultPath, pluginDir)
  );
  if (!active) return null;
  const generationRoot = knowledgeBaseHistoryGenerationRoot(
    vaultPath,
    pluginDir,
    active.generationId
  );
  const generation = parseGenerationManifest(
    JSON.parse(
      await readFile(path.join(generationRoot, "manifest.json"), "utf8")
    ) as unknown
  );
  const suppressions = parseSuppressions(
    JSON.parse(
      await readFile(path.join(generationRoot, "suppressions.json"), "utf8")
    ) as unknown
  );
  const index = parseHistoryIndexV2(
    JSON.parse(
      await readFile(path.join(generationRoot, "index.json"), "utf8")
    ) as unknown
  );
  if (
    generation.generationId !== active.generationId
    || stableRevision(generation) !== active.generationRevision
    || generation.sourceRevision !== active.sourceRevision
    || generation.suppressionRevision !== active.suppressionRevision
    || suppressions.revision !== active.suppressionRevision
    || stableRevision(index) !== generation.indexRevision
    || generation.projectionRevision
      !== projectionRevision(
        generation.indexRevision,
        generation.suppressionRevision,
        generation.files
      )
  ) {
    throw new Error(
      "Knowledge History recovery required: active generation manifest conflict"
    );
  }
  assertManifestCounts(generation, index);
  return {
    active,
    generation,
    suppressions,
    index,
    generationRoot
  };
}

async function readHistoryActive(
  file: string
): Promise<KnowledgeBaseHistoryActiveV2 | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      "Knowledge History recovery required: active manifest is invalid JSON",
      { cause: error }
    );
  }
  const record = requireRecord(value, "History active manifest");
  assertExactKeys(
    record,
    [
      "version",
      "kind",
      "generationId",
      "generationRevision",
      "sourceRevision",
      "suppressionRevision",
      "publishedAt"
    ],
    "History active manifest"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || record.kind !== HISTORY_ACTIVE_KIND
    || !isSafeHistoryPathPart(record.generationId)
    || !isSha256Revision(record.generationRevision)
    || !isSha256Revision(record.sourceRevision)
    || !isSha256Revision(record.suppressionRevision)
    || !isNonNegativeSafeInteger(record.publishedAt)
  ) {
    throw new Error(
      "Knowledge History recovery required: active manifest schema is invalid"
    );
  }
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_ACTIVE_KIND,
    generationId: record.generationId,
    generationRevision: record.generationRevision,
    sourceRevision: record.sourceRevision,
    suppressionRevision: record.suppressionRevision,
    publishedAt: record.publishedAt
  };
}

async function readGenerationReferences(
  projection: KnowledgeBaseHistoryProjectionV2,
  sessionId: string,
  date: string
): Promise<KnowledgeBaseHistoryMessageReferenceV2[]> {
  const relativePath = historyDayRelativePath(sessionId, date);
  const descriptor = projection.generation.files.find(
    (file) => file.relativePath === relativePath
  );
  if (!descriptor) {
    throw new Error(
      `Knowledge History recovery required: generation file ${relativePath} is not declared`
    );
  }
  const absolute = path.join(projection.generationRoot, relativePath);
  const text = await readFile(absolute, "utf8");
  if (sha256Text(text) !== descriptor.digest) {
    throw new Error(
      `Knowledge History recovery required: generation file ${relativePath} digest mismatch`
    );
  }
  const references = parseReferenceRows(text, relativePath);
  if (references.length !== descriptor.rowCount) {
    throw new Error(
      `Knowledge History recovery required: generation file ${relativePath} row count mismatch`
    );
  }
  for (const reference of references) {
    if (reference.conversationId !== sessionId) {
      throw new Error(
        `Knowledge History recovery required: generation file ${relativePath} conversation mismatch`
      );
    }
  }
  return references;
}

async function validateGenerationDirectory(
  generationRoot: string,
  generation: KnowledgeBaseHistoryGenerationV2,
  expectedIndex: KnowledgeBaseHistoryIndex,
  expectedSuppressions: KnowledgeBaseHistorySuppressionsV2,
  source: KnowledgeBaseHistorySource
): Promise<void> {
  const readManifest = parseGenerationManifest(
    JSON.parse(
      await readFile(path.join(generationRoot, "manifest.json"), "utf8")
    ) as unknown
  );
  const readIndex = parseHistoryIndexV2(
    JSON.parse(
      await readFile(path.join(generationRoot, "index.json"), "utf8")
    ) as unknown
  );
  const readSuppressions = parseSuppressions(
    JSON.parse(
      await readFile(path.join(generationRoot, "suppressions.json"), "utf8")
    ) as unknown
  );
  if (
    stableRevision(readManifest) !== stableRevision(generation)
    || stableRevision(readIndex) !== stableRevision(expectedIndex)
    || stableRevision(readSuppressions)
      !== stableRevision(expectedSuppressions)
  ) {
    throw new Error(
      "Knowledge History recovery required: staged generation readback mismatch"
    );
  }
  const actualFiles = await listHistoryGenerationDayFiles(generationRoot);
  const declaredFiles = generation.files.map(
    (file) => file.relativePath
  );
  if (stableJson(actualFiles) !== stableJson(declaredFiles)) {
    throw new Error(
      "Knowledge History recovery required: staged generation file set mismatch"
    );
  }
  const canonicalBySession = new Map(
    source.sessions.map(
      (session) => [session.id, uniqueCanonicalMessages(session)] as const
    )
  );
  for (const session of expectedIndex.sessions) {
    const canonical = canonicalBySession.get(session.sessionId);
    if (!canonical) {
      throw new Error(
        `Knowledge History recovery required: canonical Conversation ${session.sessionId} is unavailable`
      );
    }
    for (const day of session.days) {
      const relativePath = historyDayRelativePath(
        session.sessionId,
        day.date
      );
      const descriptor = generation.files.find(
        (file) => file.relativePath === relativePath
      );
      if (!descriptor) {
        throw new Error(
          `Knowledge History recovery required: staged generation omits ${relativePath}`
        );
      }
      const text = await readFile(
        path.join(generationRoot, relativePath),
        "utf8"
      );
      if (sha256Text(text) !== descriptor.digest) {
        throw new Error(
          `Knowledge History recovery required: staged generation digest mismatch for ${relativePath}`
        );
      }
      const references = parseReferenceRows(text, relativePath);
      if (references.length !== descriptor.rowCount) {
        throw new Error(
          `Knowledge History recovery required: staged generation row mismatch for ${relativePath}`
        );
      }
      assertHistoryReferencesMatchCanonical(
        references,
        canonical,
        day.date,
        session.sessionId
      );
      const messages = references.map(
        (reference) => canonical.get(reference.messageId)!
      );
      assertDaySummaryMatchesMessages(day, messages);
    }
  }
  assertManifestCounts(generation, expectedIndex);
}

function buildProjection(
  source: KnowledgeBaseHistorySource,
  suppressions: KnowledgeBaseHistorySuppressionsV2,
  retentionDays: number | null,
  cutoff: string | null,
  now: number,
  selectedMessageKeys?: ReadonlySet<string>
): {
  index: KnowledgeBaseHistoryIndex;
  days: Array<{
    sessionId: string;
    date: string;
    references: KnowledgeBaseHistoryMessageReferenceV2[];
  }>;
} {
  const suppressed = new Set(
    suppressions.entries.map(
      (entry) => suppressionKey(entry.conversationId, entry.messageId)
    )
  );
  const sessions: KnowledgeBaseHistorySessionSummary[] = [];
  const days: Array<{
    sessionId: string;
    date: string;
    references: KnowledgeBaseHistoryMessageReferenceV2[];
  }> = [];
  for (const session of source.sessions) {
    const canonical = uniqueCanonicalMessages(session);
    const retained = session.messages.filter((message) => {
      const date = localDateKeyForTimestamp(message.createdAt);
      return (
        (
          selectedMessageKeys === undefined
          || selectedMessageKeys.has(
            historyMessageSelectionKey(session.id, message.id)
          )
        )
        &&
        (!cutoff || date >= cutoff)
        && !suppressed.has(suppressionKey(session.id, message.id))
      );
    });
    const grouped = groupMessagesByDate(retained);
    const summaries: KnowledgeBaseHistoryDaySummary[] = [];
    for (const [date, messages] of grouped.entries()) {
      const references = messages.map((message) =>
        createHistoryMessageReference(session.id, message)
      );
      assertHistoryReferencesMatchCanonical(
        references,
        canonical,
        date,
        session.id
      );
      days.push({ sessionId: session.id, date, references });
      summaries.push(summarizeHistoryDay(date, messages));
    }
    summaries.sort((left, right) => right.date.localeCompare(left.date));
    if (summaries.length) {
      sessions.push(historySessionSummary(session, summaries, now));
    }
  }
  sessions.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt
      || left.sessionId.localeCompare(right.sessionId)
  );
  days.sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId)
      || left.date.localeCompare(right.date)
  );
  return {
    index: {
      version: KNOWLEDGE_BASE_HISTORY_VERSION,
      updatedAt: now,
      sessions
    },
    days
  };
}

function historyMigrationReferencesFromProjection(
  projection: ReturnType<typeof buildProjection>
): HistoryMigrationReferenceInput[] {
  return projection.days.flatMap((day) =>
    day.references.map((reference, ordinal) => ({
      conversationId: reference.conversationId,
      messageId: reference.messageId,
      messageRevision: reference.messageRevision,
      date: day.date,
      ordinal
    }))
  );
}

function createGenerationManifest(input: {
  generationId: string;
  createdAt: number;
  sourceRevision: string;
  suppressions: KnowledgeBaseHistorySuppressionsV2;
  retentionDays: number | null;
  retentionCutoffDate: string | null;
  index: KnowledgeBaseHistoryIndex;
  files: KnowledgeBaseHistoryGenerationFileV2[];
}): KnowledgeBaseHistoryGenerationV2 {
  const indexRevision = stableRevision(input.index);
  const manifest: KnowledgeBaseHistoryGenerationV2 = {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_GENERATION_KIND,
    generationId: input.generationId,
    createdAt: input.createdAt,
    sourceRevision: input.sourceRevision,
    suppressionRevision: input.suppressions.revision,
    retentionDays: input.retentionDays,
    retentionCutoffDate: input.retentionCutoffDate,
    indexRevision,
    projectionRevision: projectionRevision(
      indexRevision,
      input.suppressions.revision,
      input.files
    ),
    sessionCount: input.index.sessions.length,
    dayCount: input.index.sessions.reduce(
      (sum, session) => sum + session.dayCount,
      0
    ),
    messageCount: input.index.sessions.reduce(
      (sum, session) => sum + session.messageCount,
      0
    ),
    files: input.files
  };
  return manifest;
}

function createActiveManifest(
  generation: KnowledgeBaseHistoryGenerationV2
): KnowledgeBaseHistoryActiveV2 {
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_ACTIVE_KIND,
    generationId: generation.generationId,
    generationRevision: stableRevision(generation),
    sourceRevision: generation.sourceRevision,
    suppressionRevision: generation.suppressionRevision,
    publishedAt: Date.now()
  };
}

function createSuppressions(
  entries: KnowledgeBaseHistorySuppressionV2[],
  updatedAt: number
): KnowledgeBaseHistorySuppressionsV2 {
  const normalized = normalizeSuppressionEntries(entries);
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_SUPPRESSIONS_KIND,
    revision: stableRevision({
      version: KNOWLEDGE_BASE_HISTORY_VERSION,
      kind: HISTORY_SUPPRESSIONS_KIND,
      entries: normalized
    }),
    updatedAt,
    entries: normalized
  };
}

function suppressionForMessage(
  conversationId: string,
  message: ChatMessage,
  suppressedAt: number
): KnowledgeBaseHistorySuppressionV2 {
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    conversationId,
    messageId: message.id,
    messageRevision: createConversationProductMessageRevision(message),
    date: localDateKeyForTimestamp(message.createdAt),
    suppressedAt,
    reason: "user-delete"
  };
}

function mergeSuppressionEntries(
  existing: readonly KnowledgeBaseHistorySuppressionV2[],
  incoming: readonly KnowledgeBaseHistorySuppressionV2[]
): KnowledgeBaseHistorySuppressionV2[] {
  const entries = new Map<string, KnowledgeBaseHistorySuppressionV2>();
  for (const entry of [...existing, ...incoming]) {
    const key = suppressionKey(entry.conversationId, entry.messageId);
    const previous = entries.get(key);
    entries.set(
      key,
      previous && previous.suppressedAt <= entry.suppressedAt
        ? previous
        : entry
    );
  }
  return normalizeSuppressionEntries([...entries.values()]);
}

function normalizeSuppressionEntries(
  entries: readonly KnowledgeBaseHistorySuppressionV2[]
): KnowledgeBaseHistorySuppressionV2[] {
  const unique = new Map<string, KnowledgeBaseHistorySuppressionV2>();
  for (const value of entries) {
    const entry = parseSuppression(value);
    const key = suppressionKey(entry.conversationId, entry.messageId);
    if (unique.has(key)) {
      throw new Error(
        `Knowledge History recovery required: duplicate suppression ${entry.conversationId}/${entry.messageId}`
      );
    }
    unique.set(key, entry);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.conversationId.localeCompare(right.conversationId)
      || left.messageId.localeCompare(right.messageId)
  );
}

function parseSuppressions(
  value: unknown
): KnowledgeBaseHistorySuppressionsV2 {
  const record = requireRecord(value, "History suppressions");
  assertExactKeys(
    record,
    ["version", "kind", "revision", "updatedAt", "entries"],
    "History suppressions"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || record.kind !== HISTORY_SUPPRESSIONS_KIND
    || !isSha256Revision(record.revision)
    || !isNonNegativeSafeInteger(record.updatedAt)
    || !Array.isArray(record.entries)
  ) {
    throw new Error(
      "Knowledge History recovery required: suppressions schema is invalid"
    );
  }
  const entries = normalizeSuppressionEntries(
    record.entries.map(parseSuppression)
  );
  const parsed: KnowledgeBaseHistorySuppressionsV2 = {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_SUPPRESSIONS_KIND,
    revision: record.revision,
    updatedAt: record.updatedAt,
    entries
  };
  if (
    parsed.revision
    !== createSuppressions(entries, parsed.updatedAt).revision
  ) {
    throw new Error(
      "Knowledge History recovery required: suppressions revision mismatch"
    );
  }
  return parsed;
}

function parseSuppression(
  value: unknown
): KnowledgeBaseHistorySuppressionV2 {
  const record = requireRecord(value, "History suppression");
  assertExactKeys(
    record,
    [
      "version",
      "conversationId",
      "messageId",
      "messageRevision",
      "date",
      "suppressedAt",
      "reason"
    ],
    "History suppression"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || typeof record.conversationId !== "string"
    || !record.conversationId.trim()
    || typeof record.messageId !== "string"
    || !record.messageId.trim()
    || !isSha256Revision(record.messageRevision)
    || typeof record.date !== "string"
    || !isHistoryDateKey(record.date)
    || !isNonNegativeSafeInteger(record.suppressedAt)
    || record.reason !== "user-delete"
  ) {
    throw new Error(
      "Knowledge History recovery required: suppression schema is invalid"
    );
  }
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    conversationId: record.conversationId,
    messageId: record.messageId,
    messageRevision: record.messageRevision,
    date: record.date,
    suppressedAt: record.suppressedAt,
    reason: "user-delete"
  };
}

function parseGenerationManifest(
  value: unknown
): KnowledgeBaseHistoryGenerationV2 {
  const record = requireRecord(value, "History generation");
  assertExactKeys(
    record,
    [
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
    ],
    "History generation"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || record.kind !== HISTORY_GENERATION_KIND
    || !isSafeHistoryPathPart(record.generationId)
    || !isNonNegativeSafeInteger(record.createdAt)
    || !isSha256Revision(record.sourceRevision)
    || !isSha256Revision(record.suppressionRevision)
    || (
      record.retentionDays !== null
      && !isPositiveSafeInteger(record.retentionDays)
    )
    || (
      record.retentionCutoffDate !== null
      && (
        typeof record.retentionCutoffDate !== "string"
        || !isHistoryDateKey(record.retentionCutoffDate)
      )
    )
    || (
      (record.retentionDays === null)
      !== (record.retentionCutoffDate === null)
    )
    || !isSha256Revision(record.indexRevision)
    || !isSha256Revision(record.projectionRevision)
    || !isNonNegativeSafeInteger(record.sessionCount)
    || !isNonNegativeSafeInteger(record.dayCount)
    || !isNonNegativeSafeInteger(record.messageCount)
    || !Array.isArray(record.files)
  ) {
    throw new Error(
      "Knowledge History recovery required: generation schema is invalid"
    );
  }
  const files = record.files.map(parseGenerationFile);
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.relativePath)) {
      throw new Error(
        `Knowledge History recovery required: duplicate generation file ${file.relativePath}`
      );
    }
    paths.add(file.relativePath);
  }
  if (
    stableJson(files)
    !== stableJson(
      [...files].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      )
    )
  ) {
    throw new Error(
      "Knowledge History recovery required: generation files are not canonical"
    );
  }
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_GENERATION_KIND,
    generationId: record.generationId,
    createdAt: record.createdAt,
    sourceRevision: record.sourceRevision,
    suppressionRevision: record.suppressionRevision,
    retentionDays: record.retentionDays,
    retentionCutoffDate: record.retentionCutoffDate,
    indexRevision: record.indexRevision,
    projectionRevision: record.projectionRevision,
    sessionCount: record.sessionCount,
    dayCount: record.dayCount,
    messageCount: record.messageCount,
    files
  };
}

function parseGenerationFile(
  value: unknown
): KnowledgeBaseHistoryGenerationFileV2 {
  const record = requireRecord(value, "History generation file");
  assertExactKeys(
    record,
    ["relativePath", "digest", "rowCount"],
    "History generation file"
  );
  if (
    typeof record.relativePath !== "string"
    || !isSafeGenerationRelativePath(record.relativePath)
    || !isSha256Revision(record.digest)
    || !isNonNegativeSafeInteger(record.rowCount)
  ) {
    throw new Error(
      "Knowledge History recovery required: generation file schema is invalid"
    );
  }
  return {
    relativePath: record.relativePath,
    digest: record.digest,
    rowCount: record.rowCount
  };
}

function parseHistoryIndexV2(value: unknown): KnowledgeBaseHistoryIndex {
  const record = requireRecord(value, "History V2 index");
  assertExactKeys(
    record,
    ["version", "updatedAt", "sessions"],
    "History V2 index"
  );
  if (
    record.version !== KNOWLEDGE_BASE_HISTORY_VERSION
    || !isNonNegativeSafeInteger(record.updatedAt)
    || !Array.isArray(record.sessions)
  ) {
    throw new Error(
      "Knowledge History recovery required: V2 index schema is invalid"
    );
  }
  const sessions = record.sessions.map(parseHistorySessionSummaryV2);
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (sessionIds.has(session.sessionId)) {
      throw new Error(
        `Knowledge History recovery required: duplicate index session ${session.sessionId}`
      );
    }
    sessionIds.add(session.sessionId);
  }
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    updatedAt: record.updatedAt,
    sessions
  };
}

function parseHistorySessionSummaryV2(
  value: unknown
): KnowledgeBaseHistorySessionSummary {
  const record = requireRecord(value, "History V2 session summary");
  assertExactKeys(
    record,
    [
      "sessionId",
      "title",
      "kind",
      "activeDate",
      "messageCount",
      "dayCount",
      "updatedAt",
      "days"
    ],
    "History V2 session summary"
  );
  if (
    typeof record.sessionId !== "string"
    || !record.sessionId.trim()
    || typeof record.title !== "string"
    || !record.title.trim()
    || record.kind !== "knowledge-base"
    || typeof record.activeDate !== "string"
    || (
      record.activeDate
      && !isHistoryDateKey(record.activeDate)
    )
    || !isNonNegativeSafeInteger(record.messageCount)
    || !isNonNegativeSafeInteger(record.dayCount)
    || !isNonNegativeSafeInteger(record.updatedAt)
    || !Array.isArray(record.days)
  ) {
    throw new Error(
      "Knowledge History recovery required: V2 session summary schema is invalid"
    );
  }
  const days = record.days.map(parseHistoryDaySummaryV2);
  const dates = new Set<string>();
  for (const day of days) {
    if (dates.has(day.date)) {
      throw new Error(
        `Knowledge History recovery required: duplicate index day ${record.sessionId}/${day.date}`
      );
    }
    dates.add(day.date);
  }
  if (
    record.dayCount !== days.length
    || record.messageCount
      !== days.reduce((sum, day) => sum + day.messageCount, 0)
    || stableJson(days)
      !== stableJson(
        [...days].sort((left, right) =>
          right.date.localeCompare(left.date)
        )
      )
  ) {
    throw new Error(
      "Knowledge History recovery required: V2 session summary counts are invalid"
    );
  }
  return {
    sessionId: record.sessionId,
    title: record.title,
    kind: "knowledge-base",
    activeDate: record.activeDate,
    messageCount: record.messageCount,
    dayCount: record.dayCount,
    updatedAt: record.updatedAt,
    days
  };
}

function parseHistoryDaySummaryV2(
  value: unknown
): KnowledgeBaseHistoryDaySummary {
  const record = requireRecord(value, "History V2 day summary");
  assertExactKeys(
    record,
    [
      "date",
      "messageCount",
      "userMessageCount",
      "assistantMessageCount",
      "processMessageCount",
      "failedMessageCount",
      "firstMessageAt",
      "lastMessageAt"
    ],
    "History V2 day summary"
  );
  if (
    typeof record.date !== "string"
    || !isHistoryDateKey(record.date)
    || !isNonNegativeSafeInteger(record.messageCount)
    || !isNonNegativeSafeInteger(record.userMessageCount)
    || !isNonNegativeSafeInteger(record.assistantMessageCount)
    || !isNonNegativeSafeInteger(record.processMessageCount)
    || !isNonNegativeSafeInteger(record.failedMessageCount)
    || !isNonNegativeSafeInteger(record.firstMessageAt)
    || !isNonNegativeSafeInteger(record.lastMessageAt)
    || record.userMessageCount + record.assistantMessageCount
      > record.messageCount
    || record.processMessageCount > record.messageCount
    || record.failedMessageCount > record.messageCount
    || (
      record.messageCount > 0
      && (
        record.firstMessageAt <= 0
        || record.lastMessageAt < record.firstMessageAt
      )
    )
  ) {
    throw new Error(
      "Knowledge History recovery required: V2 day summary schema is invalid"
    );
  }
  return {
    date: record.date,
    messageCount: record.messageCount,
    userMessageCount: record.userMessageCount,
    assistantMessageCount: record.assistantMessageCount,
    processMessageCount: record.processMessageCount,
    failedMessageCount: record.failedMessageCount,
    firstMessageAt: record.firstMessageAt,
    lastMessageAt: record.lastMessageAt
  };
}

async function readLegacyKnowledgeBaseHistoryIndex(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistoryIndex> {
  const file = knowledgeBaseHistoryIndexPath(vaultPath, pluginDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        version: KNOWLEDGE_BASE_HISTORY_VERSION,
        updatedAt: 0,
        sessions: []
      };
    }
    throw error;
  }
  const record = requireRecord(raw, "legacy History index");
  const version = record.version === undefined
    ? LEGACY_KNOWLEDGE_BASE_HISTORY_VERSION
    : record.version;
  if (version !== LEGACY_KNOWLEDGE_BASE_HISTORY_VERSION) {
    throw new Error(
      "Knowledge History recovery required: unsupported legacy index version"
    );
  }
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
      .map(normalizeLegacyHistorySessionSummary)
      .filter(
        (session): session is KnowledgeBaseHistorySessionSummary =>
          session !== null
      )
    : [];
  return {
    version: LEGACY_KNOWLEDGE_BASE_HISTORY_VERSION,
    updatedAt: isNonNegativeSafeInteger(record.updatedAt)
      ? record.updatedAt
      : 0,
    sessions
  };
}

async function readLegacyKnowledgeBaseHistoryDay(
  vaultPath: string,
  pluginDir: string,
  sessionId: string,
  date: string
): Promise<ChatMessage[]> {
  const file = knowledgeBaseHistoryDayPath(
    vaultPath,
    pluginDir,
    sessionId,
    date
  );
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), row: index + 1 }))
    .filter(({ line }) => Boolean(line))
    .map(({ line, row }) => {
      try {
        return validateChatMessage(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error(
          `Knowledge History recovery required: invalid legacy ChatMessage row ${row}`,
          { cause: error }
        );
      }
    });
}

async function requiresExplicitLegacyCutover(
  vaultPath: string,
  pluginDir: string
): Promise<boolean> {
  const active = await readHistoryActive(
    knowledgeBaseHistoryActivePath(vaultPath, pluginDir)
  );
  if (active) return false;

  const legacyIndexFile = knowledgeBaseHistoryIndexPath(
    vaultPath,
    pluginDir
  );
  const legacyIndexExists = await fileExists(legacyIndexFile);
  const legacySessionsRoot = path.join(
    knowledgeBaseHistoryRoot(vaultPath, pluginDir),
    "sessions"
  );
  const actualFiles = await listLegacyHistoryDayFiles(legacySessionsRoot);
  if (!legacyIndexExists) return actualFiles.length > 0;

  const index = await readLegacyKnowledgeBaseHistoryIndex(
    vaultPath,
    pluginDir
  );
  return index.sessions.length > 0 || actualFiles.length > 0;
}

async function readLegacyV1ProjectionForMigration(
  vaultPath: string,
  pluginDir: string
): Promise<LegacyKnowledgeBaseHistoryProjectionV1> {
  const legacyIndexFile = knowledgeBaseHistoryIndexPath(vaultPath, pluginDir);
  const legacyIndexExists = await fileExists(legacyIndexFile);
  const legacySessionsRoot = path.join(
    knowledgeBaseHistoryRoot(vaultPath, pluginDir),
    "sessions"
  );
  const actualFiles = await listLegacyHistoryDayFiles(legacySessionsRoot);
  if (!legacyIndexExists) {
    if (actualFiles.length) {
      throw new Error(
        "Knowledge History migration blocked: legacy day files exist without an index"
      );
    }
    return {
      references: [],
      selectedMessageKeys: new Set<string>()
    };
  }
  const index = await readLegacyKnowledgeBaseHistoryIndex(
    vaultPath,
    pluginDir
  );
  const expectedFiles = index.sessions.flatMap((session) =>
    session.days.map((day) =>
      path.posix.join(
        sanitizeHistoryPathPart(session.sessionId),
        `${sanitizeHistoryPathPart(day.date)}.jsonl`
      )
    )
  ).sort();
  if (stableJson(actualFiles) !== stableJson(expectedFiles)) {
    throw new Error(
      "Knowledge History migration blocked: legacy index and day file set disagree"
    );
  }
  const references: HistoryMigrationReferenceInput[] = [];
  const selectedMessageKeys = new Set<string>();
  for (const session of index.sessions) {
    for (const day of session.days) {
      const messages = await readLegacyKnowledgeBaseHistoryDay(
        vaultPath,
        pluginDir,
        session.sessionId,
        day.date
      );
      assertDaySummaryMatchesMessages(day, messages);
      messages.forEach((message, ordinal) => {
        references.push({
          conversationId: session.sessionId,
          messageId: message.id,
          messageRevision:
            createConversationProductMessageRevision(message),
          date: day.date,
          ordinal
        });
        selectedMessageKeys.add(
          historyMessageSelectionKey(session.sessionId, message.id)
        );
      });
    }
  }
  return { references, selectedMessageKeys };
}

async function readStableKnowledgeBaseHistorySource(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistorySource> {
  const first = await readKnowledgeBaseHistorySource(vaultPath, pluginDir);
  const second = await readKnowledgeBaseHistorySource(vaultPath, pluginDir);
  if (first.revision !== second.revision) {
    throw new Error(
      "Knowledge History publication blocked: canonical Conversation inventory is unstable"
    );
  }
  return second;
}

async function readKnowledgeBaseHistorySource(
  vaultPath: string,
  pluginDir: string
): Promise<KnowledgeBaseHistorySource> {
  const sessions = (await readCanonicalKnowledgeSessions(
    vaultPath,
    pluginDir
  ))
    .filter((session) => session.kind === "knowledge-base")
    .map((session) => structuredClone(session))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) {
      throw new Error(
        `Knowledge History recovery required: duplicate canonical Conversation ${session.id}`
      );
    }
    ids.add(session.id);
    uniqueCanonicalMessages(session);
  }
  const revision = stableRevision(
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      kind: session.kind,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message) => ({
        id: message.id,
        revision: createConversationProductMessageRevision(message)
      }))
    }))
  );
  return { sessions, revision };
}

async function readCanonicalKnowledgeSessions(
  vaultPath: string,
  pluginDir: string
): Promise<StoredSession[]> {
  const storageRootPath = pluginDataDir(vaultPath, pluginDir);
  const selection = await resolveConversationStoreSelection(storageRootPath);
  if (selection.activeStore === "v1") {
    return await knowledgeBaseConversationStore(
      vaultPath,
      pluginDir
    ).listSessions();
  }
  const snapshot = await new FileConversationStoreV2({
    storageRootPath
  }).inspectMigrationSnapshot();
  return snapshot.commits.map(projectConversationCommitV2ForHistory);
}

function knowledgeBaseConversationStore(
  vaultPath: string,
  pluginDir: string
): FileConversationStore {
  return new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, pluginDir),
      "conversations"
    )
  });
}

async function readCanonicalKnowledgeConversation(
  vaultPath: string,
  pluginDir: string,
  sessionId: string
): Promise<StoredSession> {
  const storageRootPath = pluginDataDir(vaultPath, pluginDir);
  const selection = await resolveConversationStoreSelection(storageRootPath);
  const session = selection.activeStore === "v1"
    ? await knowledgeBaseConversationStore(
      vaultPath,
      pluginDir
    ).readSession(sessionId)
    : await new FileConversationStoreV2({
      storageRootPath
    }).readConversation(sessionId).then((commit) =>
      commit ? projectConversationCommitV2ForHistory(commit) : null);
  if (!session || session.kind !== "knowledge-base") {
    throw new Error(
      `Knowledge History recovery required: canonical Conversation ${sessionId} is unavailable`
    );
  }
  return session;
}

function projectConversationCommitV2ForHistory(
  commit: ConversationCommitV2
): StoredSession {
  return {
    id: commit.metadata.conversationId,
    title: commit.metadata.title,
    kind: commit.metadata.kind,
    revision: commit.metadata.revision,
    generation: commit.metadata.currentContext.generation,
    contextId: commit.metadata.currentContext.id,
    commitId: commit.metadata.commitId,
    workspaceFingerprint:
      commit.metadata.currentContext.workspaceFingerprint,
    cwd: commit.metadata.currentContext.cwd,
    messages: commit.payload.messages.map(
      projectConversationMessageV2ForHistory
    ),
    createdAt: commit.metadata.createdAt,
    updatedAt: commit.metadata.updatedAt
  };
}

function projectConversationMessageV2ForHistory(
  message: MessageV2
): ChatMessage {
  const presentation = message.presentation;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.previewText !== undefined
      ? { previewText: message.previewText }
      : {}),
    ...(message.raw
      ? {
        rawRef: message.raw.ref,
        rawSize: message.raw.size,
        rawLines: message.raw.lines,
        rawTruncatedForPreview: message.raw.truncatedForPreview
      }
      : {}),
    ...(presentation?.itemType !== undefined
      ? { itemType: presentation.itemType }
      : {}),
    ...(presentation?.title !== undefined
      ? { title: presentation.title }
      : {}),
    ...(presentation?.status !== undefined
      ? { status: presentation.status }
      : {}),
    ...(presentation?.details !== undefined
      ? { details: presentation.details }
      : {}),
    ...(presentation?.attachments !== undefined
      ? {
        attachments: cloneHistoryProjectionValue(
          presentation.attachments
        ) as unknown as ChatMessage["attachments"]
      }
      : {}),
    ...(presentation?.files !== undefined
      ? {
        files: cloneHistoryProjectionValue(
          presentation.files
        ) as unknown as ChatMessage["files"]
      }
      : {}),
    ...(presentation?.images !== undefined
      ? {
        images: cloneHistoryProjectionValue(
          presentation.images
        ) as unknown as ChatMessage["images"]
      }
      : {}),
    ...(presentation?.citations !== undefined
      ? {
        citations: cloneHistoryProjectionValue(
          presentation.citations
        ) as unknown as ChatMessage["citations"]
      }
      : {}),
    ...(presentation?.diffSummary !== undefined
      ? {
        diffSummary: cloneHistoryProjectionValue(
          presentation.diffSummary
        ) as unknown as ChatMessage["diffSummary"]
      }
      : {}),
    ...(presentation?.knowledgeBaseUi !== undefined
      ? {
        knowledgeBaseUi: cloneHistoryProjectionValue(
          presentation.knowledgeBaseUi
        ) as unknown as ChatMessage["knowledgeBaseUi"]
      }
      : {}),
    createdAt: message.createdAt,
    ...(message.completedAt !== undefined
      ? { completedAt: message.completedAt }
      : {})
  };
}

function cloneHistoryProjectionValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueCanonicalMessages(
  session: StoredSession
): Map<string, ChatMessage> {
  const messages = new Map<string, ChatMessage>();
  for (const message of session.messages) {
    validateChatMessage(message);
    if (messages.has(message.id)) {
      throw new Error(
        `Knowledge History recovery required: duplicate canonical message ${session.id}/${message.id}`
      );
    }
    messages.set(message.id, message);
  }
  return messages;
}

function createHistoryMessageReference(
  conversationId: string,
  message: ChatMessage
): KnowledgeBaseHistoryMessageReferenceV2 {
  validateChatMessage(message);
  return {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    kind: HISTORY_REFERENCE_KIND,
    conversationId,
    messageId: message.id,
    messageRevision: createConversationProductMessageRevision(message)
  };
}

function parseReferenceRows(
  text: string,
  label: string
): KnowledgeBaseHistoryMessageReferenceV2[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), row: index + 1 }))
    .filter(({ line }) => Boolean(line))
    .map(({ line, row }) => {
      try {
        return parseKnowledgeBaseHistoryMessageReferenceV2(
          JSON.parse(line) as unknown
        );
      } catch (error) {
        throw new Error(
          `Knowledge History recovery required: invalid V2 reference row ${row} in ${label}`,
          { cause: error }
        );
      }
    });
}

function assertHistoryReferencesMatchCanonical(
  references: readonly KnowledgeBaseHistoryMessageReferenceV2[],
  canonicalById: ReadonlyMap<string, ChatMessage>,
  date: string,
  conversationId: string
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    if (reference.conversationId !== conversationId) {
      throw new Error(
        `Knowledge History recovery required: Conversation identity mismatch ${reference.conversationId}`
      );
    }
    if (seen.has(reference.messageId)) {
      throw new Error(
        `Knowledge History recovery required: duplicate message reference ${reference.messageId}`
      );
    }
    seen.add(reference.messageId);
    const canonical = canonicalById.get(reference.messageId);
    if (
      !canonical
      || createConversationProductMessageRevision(canonical)
        !== reference.messageRevision
      || localDateKeyForTimestamp(canonical.createdAt) !== date
    ) {
      throw new Error(
        `Knowledge History recovery required: canonical message conflict ${reference.messageId}`
      );
    }
  }
}

function groupMessagesByDate(
  messages: readonly ChatMessage[]
): Map<string, ChatMessage[]> {
  const grouped = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const date = localDateKeyForTimestamp(message.createdAt);
    const bucket = grouped.get(date) ?? [];
    bucket.push(message);
    grouped.set(date, bucket);
  }
  return grouped;
}

function sortedKnowledgeBaseMessageDates(
  messages: readonly ChatMessage[]
): string[] {
  return [
    ...new Set(
      messages.map((message) =>
        localDateKeyForTimestamp(message.createdAt)
      )
    )
  ].sort();
}

function summarizeHistoryDay(
  date: string,
  messages: readonly ChatMessage[]
): KnowledgeBaseHistoryDaySummary {
  const timestamps = messages
    .map((message) => message.createdAt || 0)
    .filter(Boolean);
  return {
    date,
    messageCount: messages.length,
    userMessageCount: messages.filter(
      (message) => message.role === "user"
    ).length,
    assistantMessageCount: messages.filter(
      (message) => message.role === "assistant"
    ).length,
    processMessageCount: messages.filter(
      (message) =>
        Boolean(message.itemType)
        && message.role !== "user"
        && message.role !== "assistant"
    ).length,
    failedMessageCount: messages.filter(
      (message) =>
        message.status === "failed"
        || message.status === "error"
    ).length,
    firstMessageAt: timestamps.length ? Math.min(...timestamps) : 0,
    lastMessageAt: timestamps.length ? Math.max(...timestamps) : 0
  };
}

function assertDaySummaryMatchesMessages(
  summary: KnowledgeBaseHistoryDaySummary,
  messages: readonly ChatMessage[]
): void {
  const actual = summarizeHistoryDay(summary.date, messages);
  if (stableJson(actual) !== stableJson(summary)) {
    throw new Error(
      `Knowledge History recovery required: day summary mismatch ${summary.date}`
    );
  }
}

function historySessionSummary(
  session: StoredSession,
  days: KnowledgeBaseHistoryDaySummary[],
  now: number
): KnowledgeBaseHistorySessionSummary {
  const messageCount = days.reduce(
    (sum, day) => sum + day.messageCount,
    0
  );
  return {
    sessionId: session.id,
    title: session.title || "知识库管理",
    kind: "knowledge-base",
    activeDate:
      activeKnowledgeBaseHistoryDate(
        session.messages,
        session.historyActiveDate,
        now
      )
      || days[0]?.date
      || "",
    messageCount,
    dayCount: days.length,
    updatedAt: Math.max(
      session.updatedAt || 0,
      ...days.map((day) => day.lastMessageAt)
    ),
    days
  };
}

function normalizeLegacyHistorySessionSummary(
  value: unknown
): KnowledgeBaseHistorySessionSummary | null {
  const record = historyRecord(value);
  if (
    typeof record?.sessionId !== "string"
    || !record.sessionId.trim()
    || !Array.isArray(record.days)
  ) {
    return null;
  }
  const days = record.days
    .map(normalizeLegacyHistoryDaySummary)
    .filter(
      (day): day is KnowledgeBaseHistoryDaySummary => day !== null
    );
  return {
    sessionId: record.sessionId,
    title:
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : "知识库管理",
    kind: "knowledge-base",
    activeDate:
      typeof record.activeDate === "string"
        ? record.activeDate
        : days[0]?.date ?? "",
    messageCount:
      isNonNegativeSafeInteger(record.messageCount)
        ? record.messageCount
        : days.reduce((sum, day) => sum + day.messageCount, 0),
    dayCount:
      isNonNegativeSafeInteger(record.dayCount)
        ? record.dayCount
        : days.length,
    updatedAt:
      isNonNegativeSafeInteger(record.updatedAt) ? record.updatedAt : 0,
    days
  };
}

function normalizeLegacyHistoryDaySummary(
  value: unknown
): KnowledgeBaseHistoryDaySummary | null {
  const record = historyRecord(value);
  if (
    typeof record?.date !== "string"
    || !isHistoryDateKey(record.date)
  ) {
    return null;
  }
  return {
    date: record.date,
    messageCount: numberOrZero(record.messageCount),
    userMessageCount: numberOrZero(record.userMessageCount),
    assistantMessageCount: numberOrZero(record.assistantMessageCount),
    processMessageCount: numberOrZero(record.processMessageCount),
    failedMessageCount: numberOrZero(record.failedMessageCount),
    firstMessageAt: numberOrZero(record.firstMessageAt),
    lastMessageAt: numberOrZero(record.lastMessageAt)
  };
}

function parseHistoryDaySummaryForManifest(
  value: KnowledgeBaseHistoryDaySummary
): KnowledgeBaseHistoryDaySummary {
  return parseHistoryDaySummaryV2(value);
}

function assertManifestCounts(
  generation: KnowledgeBaseHistoryGenerationV2,
  index: KnowledgeBaseHistoryIndex
): void {
  const dayCount = index.sessions.reduce(
    (sum, session) => sum + session.dayCount,
    0
  );
  const messageCount = index.sessions.reduce(
    (sum, session) => sum + session.messageCount,
    0
  );
  if (
    generation.sessionCount !== index.sessions.length
    || generation.dayCount !== dayCount
    || generation.messageCount !== messageCount
    || generation.files.length !== dayCount
    || generation.files.reduce(
      (sum, file) => sum + file.rowCount,
      0
    ) !== messageCount
  ) {
    throw new Error(
      "Knowledge History recovery required: generation counts conflict"
    );
  }
  for (const session of index.sessions) {
    for (const day of session.days) {
      parseHistoryDaySummaryForManifest(day);
    }
  }
}

function parseReferenceDigest(value: unknown): string {
  if (!isSha256Revision(value)) {
    throw new Error("Knowledge History recovery required: digest is invalid");
  }
  return value;
}

function projectionRevision(
  indexRevision: string,
  suppressionRevision: string,
  files: readonly KnowledgeBaseHistoryGenerationFileV2[]
): string {
  return stableRevision({
    indexRevision: parseReferenceDigest(indexRevision),
    suppressionRevision: parseReferenceDigest(suppressionRevision),
    files
  });
}

function normalizeRetentionDays(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(1, Math.round(value));
}

function retentionCutoffDate(
  retentionDays: number | null,
  now: number
): string | null {
  if (retentionDays === null) return null;
  return localDateKeyForTimestamp(
    now - retentionDays * 24 * 60 * 60 * 1000
  );
}

function createGenerationId(now: number): string {
  return `g-${Math.max(0, Math.round(now))}-${randomUUID()}`;
}

function historyDayRelativePath(
  sessionId: string,
  date: string
): string {
  if (!sessionId.trim() || !isHistoryDateKey(date)) {
    throw new Error(
      "Knowledge History recovery required: History day identity is invalid"
    );
  }
  return path.posix.join(
    "sessions",
    sanitizeHistoryPathPart(sessionId),
    `${sanitizeHistoryPathPart(date)}.jsonl`
  );
}

function isSafeGenerationRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.startsWith("/")) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../")) return false;
  const parts = value.split("/");
  return (
    parts.length === 3
    && parts[0] === "sessions"
    && isSafeHistoryPathPart(parts[1])
    && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(parts[2] ?? "")
  );
}

function suppressionKey(
  conversationId: string,
  messageId: string
): string {
  return `${conversationId}\0${messageId}`;
}

function historyMessageSelectionKey(
  conversationId: string,
  messageId: string
): string {
  return `${conversationId}\0${messageId}`;
}

function parseGenerationDirectoryRelativePath(
  root: string,
  absolute: string
): string {
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!isSafeGenerationRelativePath(relative)) {
    throw new Error(
      `Knowledge History recovery required: unexpected generation path ${relative}`
    );
  }
  return relative;
}

async function listHistoryGenerationDayFiles(
  generationRoot: string
): Promise<string[]> {
  const sessionsRoot = path.join(generationRoot, "sessions");
  const result: string[] = [];
  const sessionEntries = await readdir(
    sessionsRoot,
    { withFileTypes: true }
  ).catch((error) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory()) {
      throw new Error(
        `Knowledge History recovery required: unexpected generation entry ${sessionEntry.name}`
      );
    }
    const sessionRoot = path.join(sessionsRoot, sessionEntry.name);
    const dayEntries = await readdir(sessionRoot, {
      withFileTypes: true
    });
    for (const dayEntry of dayEntries) {
      if (!dayEntry.isFile()) {
        throw new Error(
          `Knowledge History recovery required: unexpected generation entry ${dayEntry.name}`
        );
      }
      result.push(
        parseGenerationDirectoryRelativePath(
          generationRoot,
          path.join(sessionRoot, dayEntry.name)
        )
      );
    }
  }
  return result.sort();
}

async function listLegacyHistoryDayFiles(
  sessionsRoot: string
): Promise<string[]> {
  const result: string[] = [];
  const sessionEntries = await readdir(
    sessionsRoot,
    { withFileTypes: true }
  ).catch((error) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory()) {
      throw new Error(
        `Knowledge History migration blocked: unexpected legacy entry ${sessionEntry.name}`
      );
    }
    const sessionRoot = path.join(sessionsRoot, sessionEntry.name);
    const dayEntries = await readdir(sessionRoot, {
      withFileTypes: true
    });
    for (const dayEntry of dayEntries) {
      if (
        !dayEntry.isFile()
        || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(dayEntry.name)
      ) {
        throw new Error(
          `Knowledge History migration blocked: unexpected legacy entry ${sessionEntry.name}/${dayEntry.name}`
        );
      }
      result.push(
        path.posix.join(sessionEntry.name, dayEntry.name)
      );
    }
  }
  return result.sort();
}

async function withHistoryWriterLane<T>(
  historyRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(historyRoot);
  const previous = historyWriterTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => tail);
  historyWriterTails.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (historyWriterTails.get(key) === queued) {
      historyWriterTails.delete(key);
    }
  }
}

function createHashRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function sha256Text(text: string): string {
  return createHashRevision(text);
}

function stableRevision(value: unknown): string {
  return createHashRevision(stableJson(value));
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(stableJsonValue(value));
  if (serialized === undefined) {
    throw new Error(
      "Knowledge History recovery required: value is not JSON serializable"
    );
  }
  return serialized;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : stableJsonValue(item)
    );
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      sorted[key] = stableJsonValue(record[key]);
    }
  }
  return sorted;
}

function jsonlText(rows: readonly unknown[]): string {
  return (
    rows.map((row) => JSON.stringify(row)).join("\n")
    + (rows.length ? "\n" : "")
  );
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (isNotFoundError(error)) return 0;
    throw error;
  }
}

async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(
    dir,
    { withFileTypes: true }
  ).catch((error) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    if (entry.isFile()) total += await fileSize(full);
  }
  return total;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function historyRecord(
  value: unknown
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  const record = historyRecord(value);
  if (!record) {
    throw new Error(
      `Knowledge History recovery required: ${label} must be an object`
    );
  }
  return record;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(record).find((key) => !allowedSet.has(key));
  if (extra) {
    throw new Error(
      `Knowledge History recovery required: ${label} contains unknown field ${extra}`
    );
  }
}

function sanitizeHistoryPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function isSafeHistoryPathPart(value: unknown): value is string {
  return (
    typeof value === "string"
    && /^[a-zA-Z0-9._-]+$/.test(value)
    && value !== "."
    && value !== ".."
  );
}

function assertSafeHistoryPathPart(
  value: string,
  label: string
): void {
  if (!isSafeHistoryPathPart(value)) {
    throw new Error(
      `Knowledge History recovery required: ${label} is invalid`
    );
  }
}

function numberOrZero(value: unknown): number {
  return isNonNegativeSafeInteger(value) ? value : 0;
}

function isHistoryDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
  );
}

function isSha256Revision(value: unknown): value is string {
  return (
    typeof value === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
