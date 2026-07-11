import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { emptyArrayOnMissingPathOrWarn } from "../core/error-handling";
import { pluginDataDir, rawStorageDir, resolveRawRef } from "../core/raw-message-store";
import { isKnowledgeBaseSession, type ChatMessage, type CodexForObsidianSettings, type StoredSession } from "../settings/settings";

export const KNOWLEDGE_BASE_HISTORY_VERSION = 1;
export const KNOWLEDGE_BASE_ACTIVE_DAY_MESSAGE_LIMIT = 1000;

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

export function knowledgeBaseHistoryRoot(vaultPath: string, pluginDir: string): string {
  return path.join(pluginDataDir(vaultPath, pluginDir), "history");
}

export function knowledgeBaseHistoryIndexPath(vaultPath: string, pluginDir: string): string {
  return path.join(knowledgeBaseHistoryRoot(vaultPath, pluginDir), "index.json");
}

export function knowledgeBaseHistoryMigrationPath(vaultPath: string, pluginDir: string): string {
  return path.join(knowledgeBaseHistoryRoot(vaultPath, pluginDir), "migration.json");
}

export function knowledgeBaseHistoryDayPath(vaultPath: string, pluginDir: string, sessionId: string, date: string): string {
  return path.join(knowledgeBaseHistoryRoot(vaultPath, pluginDir), "sessions", sanitizeHistoryPathPart(sessionId), `${sanitizeHistoryPathPart(date)}.jsonl`);
}

export function localDateKeyForTimestamp(value: number): string {
  const date = new Date(Number.isFinite(value) && value > 0 ? value : Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function latestKnowledgeBaseMessageDate(messages: ChatMessage[]): string {
  let latest = 0;
  for (const message of messages) {
    if ((message.createdAt || 0) > latest) latest = message.createdAt || 0;
  }
  return latest ? localDateKeyForTimestamp(latest) : "";
}

export function activeKnowledgeBaseHistoryDate(messages: ChatMessage[], currentActiveDate = "", now = Date.now()): string {
  const dates = sortedKnowledgeBaseMessageDates(messages);
  if (!dates.length) return "";
  const today = localDateKeyForTimestamp(now);
  const latestBeforeToday = [...dates].filter((date) => date < today).at(-1) ?? "";
  if (latestBeforeToday) {
    if (currentActiveDate && currentActiveDate < today && dates.includes(currentActiveDate) && currentActiveDate >= latestBeforeToday) return currentActiveDate;
    return latestBeforeToday;
  }
  return dates.at(-1) ?? "";
}

export function activeKnowledgeBaseMessageDates(messages: ChatMessage[], currentActiveDate = "", now = Date.now()): Set<string> {
  const dates = new Set(sortedKnowledgeBaseMessageDates(messages));
  const activeDate = activeKnowledgeBaseHistoryDate(messages, currentActiveDate, now);
  const today = localDateKeyForTimestamp(now);
  const activeDates = new Set<string>();
  if (activeDate) activeDates.add(activeDate);
  if (dates.has(today)) activeDates.add(today);
  if (!activeDates.size && dates.size) activeDates.add([...dates].at(-1) ?? "");
  activeDates.delete("");
  return activeDates;
}

export function filterKnowledgeBaseMessagesForDate(messages: ChatMessage[], date: string): ChatMessage[] {
  if (!date) return [];
  return messages.filter((message) => localDateKeyForTimestamp(message.createdAt) === date);
}

export function compactKnowledgeBaseMessagesToActiveDay(session: StoredSession, now = Date.now()): boolean {
  const activeDate = activeKnowledgeBaseHistoryDate(session.messages, session.historyActiveDate, now);
  const activeDates = activeKnowledgeBaseMessageDates(session.messages, activeDate, now);
  const activeMessages = session.messages.filter((message) => activeDates.has(localDateKeyForTimestamp(message.createdAt)));
  const changed = activeDate !== (session as any).historyActiveDate || activeMessages.length !== session.messages.length;
  session.messages = activeMessages.slice(-KNOWLEDGE_BASE_ACTIVE_DAY_MESSAGE_LIMIT);
  (session as any).historyActiveDate = activeDate || undefined;
  return changed;
}

export async function migrateKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string,
  settings: CodexForObsidianSettings
): Promise<KnowledgeBaseHistoryMutationResult> {
  const session = settings.sessions.find((item) => isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId));
  if (!session) return { changed: false, messageCount: 0, activeDate: "" };
  const beforeCount = session.messages.length;
  const result = await persistAndCompactKnowledgeBaseHistory(vaultPath, pluginDir, settings);
  const migrationPath = knowledgeBaseHistoryMigrationPath(vaultPath, pluginDir);
  const exists = await fileExists(migrationPath);
  if (!exists && beforeCount > 0) {
    const summary: KnowledgeBaseHistoryMigrationSummary = {
      version: KNOWLEDGE_BASE_HISTORY_VERSION,
      migratedAt: Date.now(),
      sessionCount: 1,
      messageCount: beforeCount,
      activeDate: result.activeDate
    };
    await writeJsonAtomic(migrationPath, summary);
    return { ...result, changed: true };
  }
  return result;
}

export async function persistAndCompactKnowledgeBaseHistory(
  vaultPath: string,
  pluginDir: string,
  settings: CodexForObsidianSettings,
  now = Date.now()
): Promise<KnowledgeBaseHistoryMutationResult> {
  const session = settings.sessions.find((item) => isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId));
  if (!session || !session.messages.length) return { changed: false, messageCount: 0, activeDate: "" };
  const hydrated = await hydrateActiveKnowledgeBaseHistoryDate(vaultPath, pluginDir, session, now);
  const messageCount = session.messages.length;
  await persistKnowledgeBaseHistoryMessages(vaultPath, pluginDir, session, session.messages);
  const changed = compactKnowledgeBaseMessagesToActiveDay(session, now);
  return {
    changed: hydrated || changed,
    messageCount,
    activeDate: (session as any).historyActiveDate ?? ""
  };
}

export async function persistKnowledgeBaseHistoryMessages(
  vaultPath: string,
  pluginDir: string,
  session: StoredSession,
  messages: ChatMessage[]
): Promise<void> {
  if (!messages.length) return;
  const grouped = groupMessagesByDate(messages);
  const touchedDays: KnowledgeBaseHistoryDaySummary[] = [];
  for (const [date, dayMessages] of grouped.entries()) {
    const file = knowledgeBaseHistoryDayPath(vaultPath, pluginDir, session.id, date);
    const existing = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.id, date).catch(emptyArrayOnMissingPathOrWarn(`read existing knowledge history day ${date}`));
    const merged = mergeHistoryMessages(existing, dayMessages);
    await writeJsonlAtomic(file, merged);
    touchedDays.push(summarizeHistoryDay(date, merged));
  }
  await updateKnowledgeBaseHistoryIndex(vaultPath, pluginDir, session, touchedDays);
}

export async function readKnowledgeBaseHistoryIndex(vaultPath: string, pluginDir: string): Promise<KnowledgeBaseHistoryIndex> {
  const file = knowledgeBaseHistoryIndexPath(vaultPath, pluginDir);
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions.map(normalizeHistorySessionSummary).filter(Boolean) as KnowledgeBaseHistorySessionSummary[] : [];
    return {
      version: KNOWLEDGE_BASE_HISTORY_VERSION,
      updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
      sessions
    };
  } catch (error) {
    if (isNotFoundError(error)) return { version: KNOWLEDGE_BASE_HISTORY_VERSION, updatedAt: 0, sessions: [] };
    throw error;
  }
}

export async function readKnowledgeBaseHistoryDay(vaultPath: string, pluginDir: string, sessionId: string, date: string): Promise<ChatMessage[]> {
  const file = knowledgeBaseHistoryDayPath(vaultPath, pluginDir, sessionId, date);
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatMessage)
    .filter((message) => message && typeof message.id === "string" && typeof message.createdAt === "number");
}

export async function rebuildKnowledgeBaseHistoryIndex(vaultPath: string, pluginDir: string): Promise<KnowledgeBaseHistoryIndex> {
  const root = knowledgeBaseHistoryRoot(vaultPath, pluginDir);
  const sessionsRoot = path.join(root, "sessions");
  const sessionDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn("read knowledge history session directories"));
  const sessions: KnowledgeBaseHistorySessionSummary[] = [];
  for (const entry of sessionDirs) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const dir = path.join(sessionsRoot, entry.name);
    const files = await readdir(dir, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn(`read knowledge history day files for ${sessionId}`));
    const days: KnowledgeBaseHistoryDaySummary[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const date = file.name.replace(/\.jsonl$/, "");
      const messages = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, sessionId, date).catch(emptyArrayOnMissingPathOrWarn(`read knowledge history day ${date} for ${sessionId}`));
      if (messages.length) days.push(summarizeHistoryDay(date, messages));
    }
    const sorted = days.sort((a, b) => b.date.localeCompare(a.date));
    const messageCount = sorted.reduce((sum, day) => sum + day.messageCount, 0);
    if (!messageCount) continue;
    sessions.push({
      sessionId,
      title: "知识库管理",
      kind: "knowledge-base",
      activeDate: sorted[0]?.date ?? "",
      messageCount,
      dayCount: sorted.length,
      updatedAt: Math.max(...sorted.map((day) => day.lastMessageAt)),
      days: sorted
    });
  }
  const index = { version: KNOWLEDGE_BASE_HISTORY_VERSION, updatedAt: Date.now(), sessions };
  await writeJsonAtomic(knowledgeBaseHistoryIndexPath(vaultPath, pluginDir), index);
  return index;
}

export async function collectKnowledgeBaseStorageStats(vaultPath: string, pluginDir: string): Promise<KnowledgeBaseStorageStats> {
  const dataJson = path.join(pluginDataDir(vaultPath, pluginDir), "data.json");
  const [dataJsonBytes, historyBytes, rawBytes, index] = await Promise.all([
    fileSize(dataJson),
    directorySize(knowledgeBaseHistoryRoot(vaultPath, pluginDir)),
    directorySize(rawStorageDir(vaultPath, pluginDir)),
    readKnowledgeBaseHistoryIndex(vaultPath, pluginDir).catch((): KnowledgeBaseHistoryIndex => ({ version: KNOWLEDGE_BASE_HISTORY_VERSION, updatedAt: 0, sessions: [] }))
  ]);
  const sessionCount = index.sessions.length;
  const dayCount = index.sessions.reduce((sum, session) => sum + session.dayCount, 0);
  const messageCount = index.sessions.reduce((sum, session) => sum + session.messageCount, 0);
  return { dataJsonBytes, historyBytes, rawBytes, sessionCount, dayCount, messageCount };
}

export async function exportKnowledgeBaseHistory(vaultPath: string, pluginDir: string, outputDir = "outputs"): Promise<string> {
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const sessions: Array<Omit<KnowledgeBaseHistorySessionSummary, "days"> & { days: Array<KnowledgeBaseHistoryDaySummary & { messages: ChatMessage[] }> }> = [];
  for (const session of index.sessions) {
    const days: Array<KnowledgeBaseHistoryDaySummary & { messages: ChatMessage[] }> = [];
    for (const day of session.days) {
      days.push({
        ...day,
        messages: await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.sessionId, day.date).catch(emptyArrayOnMissingPathOrWarn(`export knowledge history day ${day.date}`))
      });
    }
    sessions.push({ ...session, days });
  }
  const relative = `${outputDir.replace(/^\/+|\/+$/g, "")}/codex-echoink-history-export-${localDateKeyForTimestamp(Date.now())}-${Date.now()}.json`;
  const absolute = path.join(vaultPath, relative);
  await writeJsonAtomic(absolute, { version: KNOWLEDGE_BASE_HISTORY_VERSION, exportedAt: Date.now(), sessions });
  return relative.replace(/\\/g, "/");
}

export async function compactOldKnowledgeBaseProcessHistory(vaultPath: string, pluginDir: string, activeDate = localDateKeyForTimestamp(Date.now())): Promise<number> {
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  let changedCount = 0;
  for (const session of index.sessions) {
    for (const day of session.days) {
      if (day.date >= activeDate) continue;
      const messages = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.sessionId, day.date).catch(emptyArrayOnMissingPathOrWarn(`compact knowledge history day ${day.date}`));
      let changed = false;
      const compacted = messages.map((message) => {
        if (!message.itemType || message.role === "user" || message.role === "assistant") return message;
        const text = compactProcessText(message);
        if (text === message.text) return message;
        changed = true;
        changedCount += 1;
        return {
          ...message,
          text,
          previewText: undefined,
          rawRef: undefined,
          rawSize: undefined,
          rawLines: undefined,
          rawTruncatedForPreview: undefined
        };
      });
      if (changed) await writeJsonlAtomic(knowledgeBaseHistoryDayPath(vaultPath, pluginDir, session.sessionId, day.date), compacted);
    }
  }
  if (changedCount) await rebuildKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  return changedCount;
}

export async function removeKnowledgeBaseHistory(vaultPath: string, pluginDir: string): Promise<KnowledgeBaseHistoryRemovalResult> {
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  let removedMessageCount = 0;
  for (const session of index.sessions) {
    for (const day of session.days) {
      const messages = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.sessionId, day.date).catch(emptyArrayOnMissingPathOrWarn(`remove knowledge history day ${day.date}`));
      removedMessageCount += messages.length || day.messageCount;
      await removeHistoryRawRefs(vaultPath, pluginDir, messages);
    }
  }
  await rm(knowledgeBaseHistoryRoot(vaultPath, pluginDir), { recursive: true, force: true });
  return {
    removedDayCount: index.sessions.reduce((sum, session) => sum + session.dayCount, 0),
    removedMessageCount
  };
}

export async function removeKnowledgeBaseHistoryDays(
  vaultPath: string,
  pluginDir: string,
  dates: string[],
  sessionId?: string
): Promise<KnowledgeBaseHistoryRemovalResult> {
  const targets = new Set(dates.map((date) => date.trim()).filter(isHistoryDateKey));
  if (!targets.size) return { removedDayCount: 0, removedMessageCount: 0 };
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const sessions = sessionId ? index.sessions.filter((session) => session.sessionId === sessionId) : index.sessions;
  let removedDayCount = 0;
  let removedMessageCount = 0;
  for (const session of sessions) {
    for (const day of session.days) {
      if (!targets.has(day.date)) continue;
      const messages = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.sessionId, day.date).catch(emptyArrayOnMissingPathOrWarn(`remove selected knowledge history day ${day.date}`));
      removedMessageCount += messages.length || day.messageCount;
      await removeHistoryRawRefs(vaultPath, pluginDir, messages);
      await rm(knowledgeBaseHistoryDayPath(vaultPath, pluginDir, session.sessionId, day.date), { force: true });
      removedDayCount += 1;
    }
  }
  if (removedDayCount) await rebuildKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  return { removedDayCount, removedMessageCount };
}

export async function pruneKnowledgeBaseHistoryByRetention(
  vaultPath: string,
  pluginDir: string,
  retentionDays: number,
  now = Date.now()
): Promise<KnowledgeBaseHistoryRemovalResult> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { removedDayCount: 0, removedMessageCount: 0 };
  const cutoff = localDateKeyForTimestamp(now - Math.max(1, Math.round(retentionDays)) * 24 * 60 * 60 * 1000);
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const dates = [...new Set(index.sessions.flatMap((session) => session.days.map((day) => day.date)).filter((date) => date < cutoff))];
  return removeKnowledgeBaseHistoryDays(vaultPath, pluginDir, dates);
}

function groupMessagesByDate(messages: ChatMessage[]): Map<string, ChatMessage[]> {
  const grouped = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const date = localDateKeyForTimestamp(message.createdAt);
    const bucket = grouped.get(date) ?? [];
    bucket.push(message);
    grouped.set(date, bucket);
  }
  return grouped;
}

async function hydrateActiveKnowledgeBaseHistoryDate(
  vaultPath: string,
  pluginDir: string,
  session: StoredSession,
  now: number
): Promise<boolean> {
  const today = localDateKeyForTimestamp(now);
  const activeDates = activeKnowledgeBaseMessageDates(session.messages, session.historyActiveDate, now);
  if ([...activeDates].some((date) => date && date !== today)) return false;
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const historySession = index.sessions.find((item) => item.sessionId === session.id);
  const historyDate = [...(historySession?.days ?? [])]
    .map((day) => day.date)
    .filter((date) => date < today && !session.messages.some((message) => localDateKeyForTimestamp(message.createdAt) === date))
    .sort((left, right) => right.localeCompare(left))[0];
  if (!historyDate) return false;
  const messages = await readKnowledgeBaseHistoryDay(vaultPath, pluginDir, session.id, historyDate).catch(emptyArrayOnMissingPathOrWarn(`hydrate active knowledge history day ${historyDate}`));
  if (!messages.length) return false;
  session.messages = mergeHistoryMessages(session.messages, messages);
  session.historyActiveDate = historyDate;
  return true;
}

function sortedKnowledgeBaseMessageDates(messages: ChatMessage[]): string[] {
  return [...new Set(messages.map((message) => localDateKeyForTimestamp(message.createdAt)))].sort();
}

function mergeHistoryMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const latest = new Map<string, ChatMessage>();
  const order = new Map<string, number>();
  let nextOrder = 0;
  for (const message of [...existing, ...incoming]) {
    if (!message.id) continue;
    if (!order.has(message.id)) order.set(message.id, nextOrder++);
    latest.set(message.id, message);
  }
  return [...latest.values()].sort((a, b) => {
    const diff = (a.createdAt || 0) - (b.createdAt || 0);
    if (diff) return diff;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

function summarizeHistoryDay(date: string, messages: ChatMessage[]): KnowledgeBaseHistoryDaySummary {
  const timestamps = messages.map((message) => message.createdAt || 0).filter(Boolean);
  return {
    date,
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.role === "user").length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    processMessageCount: messages.filter((message) => Boolean(message.itemType) && message.role !== "user" && message.role !== "assistant").length,
    failedMessageCount: messages.filter((message) => message.status === "failed" || message.status === "error").length,
    firstMessageAt: timestamps.length ? Math.min(...timestamps) : 0,
    lastMessageAt: timestamps.length ? Math.max(...timestamps) : 0
  };
}

async function updateKnowledgeBaseHistoryIndex(
  vaultPath: string,
  pluginDir: string,
  session: StoredSession,
  touchedDays: KnowledgeBaseHistoryDaySummary[]
): Promise<void> {
  const index = await readKnowledgeBaseHistoryIndex(vaultPath, pluginDir);
  const existing = index.sessions.find((item) => item.sessionId === session.id);
  const daysByDate = new Map<string, KnowledgeBaseHistoryDaySummary>();
  for (const day of existing?.days ?? []) daysByDate.set(day.date, day);
  for (const day of touchedDays) daysByDate.set(day.date, day);
  const days = [...daysByDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const messageCount = days.reduce((sum, day) => sum + day.messageCount, 0);
  const summary: KnowledgeBaseHistorySessionSummary = {
    sessionId: session.id,
    title: session.title || "知识库管理",
    kind: "knowledge-base",
    activeDate: activeKnowledgeBaseHistoryDate(session.messages, session.historyActiveDate) || days[0]?.date || "",
    messageCount,
    dayCount: days.length,
    updatedAt: Math.max(session.updatedAt || 0, ...days.map((day) => day.lastMessageAt)),
    days
  };
  const sessions = index.sessions.filter((item) => item.sessionId !== session.id);
  sessions.unshift(summary);
  await writeJsonAtomic(knowledgeBaseHistoryIndexPath(vaultPath, pluginDir), {
    version: KNOWLEDGE_BASE_HISTORY_VERSION,
    updatedAt: Date.now(),
    sessions
  } satisfies KnowledgeBaseHistoryIndex);
}

function normalizeHistorySessionSummary(value: any): KnowledgeBaseHistorySessionSummary | null {
  if (!value?.sessionId || !Array.isArray(value?.days)) return null;
  const days = value.days.map(normalizeHistoryDaySummary).filter(Boolean) as KnowledgeBaseHistoryDaySummary[];
  return {
    sessionId: String(value.sessionId),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "知识库管理",
    kind: "knowledge-base",
    activeDate: typeof value.activeDate === "string" ? value.activeDate : days[0]?.date ?? "",
    messageCount: typeof value.messageCount === "number" ? value.messageCount : days.reduce((sum, day) => sum + day.messageCount, 0),
    dayCount: typeof value.dayCount === "number" ? value.dayCount : days.length,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    days
  };
}

function normalizeHistoryDaySummary(value: any): KnowledgeBaseHistoryDaySummary | null {
  if (typeof value?.date !== "string") return null;
  return {
    date: value.date,
    messageCount: numberOrZero(value.messageCount),
    userMessageCount: numberOrZero(value.userMessageCount),
    assistantMessageCount: numberOrZero(value.assistantMessageCount),
    processMessageCount: numberOrZero(value.processMessageCount),
    failedMessageCount: numberOrZero(value.failedMessageCount),
    firstMessageAt: numberOrZero(value.firstMessageAt),
    lastMessageAt: numberOrZero(value.lastMessageAt)
  };
}

function compactProcessText(message: ChatMessage): string {
  const parts = [message.title, message.details, message.status ? `状态：${message.status}` : ""]
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
  return parts.join("\n") || "过程记录已压缩。";
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeJsonlAtomic(file: string, messages: ChatMessage[]): Promise<void> {
  await writeTextAtomic(file, messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""));
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
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
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
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

function sanitizeHistoryPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isHistoryDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function removeHistoryRawRefs(vaultPath: string, pluginDir: string, messages: ChatMessage[]): Promise<void> {
  const refs = [...new Set(messages.map((message) => message.rawRef).filter((ref): ref is string => Boolean(ref)))];
  for (const rawRef of refs) {
    await rm(resolveRawRef(vaultPath, rawRef, pluginDir), { force: true }).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
