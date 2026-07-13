import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { BackendSessionBinding } from "../contracts/run";
import type { SessionContextSnapshot } from "../contracts/context";
import type { ChatMessage, CodexForObsidianSettings, StoredSession, StoredSessionKind } from "../../settings/settings";

export interface ConversationStoreOptions {
  rootPath: string;
  now?: () => number;
}

export interface ConversationSessionSummary {
  sessionId: string;
  title: string;
  kind?: StoredSessionKind;
  messageCount: number;
  updatedAt: number;
}

interface ConversationStoreIndex {
  version: 1;
  updatedAt: number;
  sessions: ConversationSessionSummary[];
}

interface ConversationSessionMetadata {
  id: string;
  title: string;
  kind?: StoredSessionKind;
  threadId?: string;
  backendBindings?: Record<string, BackendSessionBinding>;
  revision?: number;
  contextSnapshot?: SessionContextSnapshot;
  cwd: string;
  rollingSummary?: StoredSession["rollingSummary"];
  messagesHiddenBefore?: number;
  historyActiveDate?: string;
  tokenUsage?: StoredSession["tokenUsage"];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStoreMigrationResult {
  sessionCount: number;
  messageCount: number;
  trimmedSettingsMessageCount: number;
}

export class FileConversationStore {
  private readonly now: () => number;

  constructor(private readonly options: ConversationStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async persistSettingsSessions(
    settings: Pick<CodexForObsidianSettings, "sessions">,
    options: { trimSettingsMessages?: boolean } = {}
  ): Promise<ConversationStoreMigrationResult> {
    let messageCount = 0;
    let trimmedSettingsMessageCount = 0;
    for (const session of settings.sessions) {
      messageCount += session.messages.length;
      await this.upsertSession(session);
      if (options.trimSettingsMessages && session.messages.length) {
        trimmedSettingsMessageCount += session.messages.length;
        session.messages = [];
      }
    }
    return {
      sessionCount: settings.sessions.length,
      messageCount,
      trimmedSettingsMessageCount
    };
  }

  async upsertSession(session: StoredSession): Promise<void> {
    refreshSessionContextSnapshot(session, this.now());
    const metadata = metadataFromSession(session);
    await writeJsonAtomic(this.metadataPath(session.id), metadata);
    await writeJsonlAtomic(this.messagesPath(session.id), session.messages);
    await writeJsonlAtomic(this.snapshotsPath(session.id), session.contextSnapshot ? [session.contextSnapshot] : []);
    await this.upsertIndex({
      sessionId: session.id,
      title: session.title,
      kind: session.kind,
      messageCount: session.messages.length,
      updatedAt: session.updatedAt
    });
  }

  async readSession(sessionId: string): Promise<StoredSession | null> {
    const metadata = await readJson<ConversationSessionMetadata>(this.metadataPath(sessionId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return null;
    const messages = await readJsonl<ChatMessage>(this.messagesPath(sessionId));
    const snapshots = await readJsonl<SessionContextSnapshot>(this.snapshotsPath(sessionId));
    return {
      ...metadata,
      contextSnapshot: metadata.contextSnapshot ?? snapshots.at(-1),
      messages
    };
  }

  async readIndex(): Promise<ConversationStoreIndex> {
    const text = await readFile(this.indexPath(), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (!text.trim()) return { version: 1, updatedAt: 0, sessions: [] };
    const parsed = JSON.parse(text) as Partial<ConversationStoreIndex>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isConversationSessionSummary) : []
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const index = await this.readIndex();
    const nextSessions = index.sessions.filter((item) => item.sessionId !== sessionId);
    const existed = nextSessions.length !== index.sessions.length;
    if (existed) {
      await writeJsonAtomic(this.indexPath(), {
        version: 1,
        updatedAt: this.now(),
        sessions: nextSessions
      } satisfies ConversationStoreIndex);
    }
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    return existed;
  }

  private async upsertIndex(summary: ConversationSessionSummary): Promise<void> {
    const index = await this.readIndex();
    const existingIndex = index.sessions.findIndex((item) => item.sessionId === summary.sessionId);
    if (existingIndex >= 0) index.sessions[existingIndex] = summary;
    else index.sessions.push(summary);
    index.sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
    index.updatedAt = this.now();
    await writeJsonAtomic(this.indexPath(), index);
  }

  private indexPath(): string {
    return path.join(this.options.rootPath, "index.json");
  }

  private metadataPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "metadata.json");
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "messages.jsonl");
  }

  private snapshotsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "snapshots.jsonl");
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.options.rootPath, "sessions", sanitizePathPart(sessionId));
  }
}

function refreshSessionContextSnapshot(session: StoredSession, now: number): void {
  const sourceMessages = summarizableMessages(session.messages);
  if (!sourceMessages.length) return;
  const first = sourceMessages[0];
  const last = sourceMessages[sourceMessages.length - 1];
  if (
    session.contextSnapshot?.summarizedThroughMessageId === last.id
    && session.contextSnapshot.sourceMessageCount === sourceMessages.length
  ) {
    return;
  }
  const firstUser = sourceMessages.find((message) => message.role === "user");
  const lastAssistant = sourceMessages.slice().reverse().find((message) => message.role === "assistant");
  const titleGoal = session.title && session.title !== "新会话" ? session.title : "";
  session.contextSnapshot = {
    sessionId: session.id,
    version: `snapshot-v1:${last.id}:${now}`,
    goal: compactSnapshotText(titleGoal || firstUser?.text || "", 600),
    currentState: compactSnapshotText(lastAssistant?.text || last.text, 1200),
    decisions: [],
    constraints: [],
    openLoops: last.role === "user" ? [compactSnapshotText(last.text, 600)].filter(Boolean) : [],
    keyReferences: [],
    rollingSummary: sourceMessages.slice(-12).map(snapshotMessageLine).join("\n").slice(0, 8000),
    summarizedFromMessageId: first.id,
    summarizedThroughMessageId: last.id,
    sourceMessageCount: sourceMessages.length,
    createdAt: session.contextSnapshot?.createdAt ?? now,
    updatedAt: now
  };
  session.rollingSummary = {
    text: session.contextSnapshot.rollingSummary,
    updatedAt: now
  };
}

function summarizableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) =>
    (message.role === "user" || message.role === "assistant")
    && typeof message.text === "string"
    && message.text.trim().length > 0
  );
}

function snapshotMessageLine(message: ChatMessage): string {
  const source = [message.backendId, message.modelId].filter(Boolean).join("/");
  const prefix = source ? `${message.role}(${source})` : message.role;
  return `${prefix}: ${compactSnapshotText(message.text, 700)}`;
}

function compactSnapshotText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

function metadataFromSession(session: StoredSession): ConversationSessionMetadata {
  return {
    id: session.id,
    title: session.title,
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.backendBindings ? { backendBindings: session.backendBindings } : {}),
    ...(session.revision ? { revision: session.revision } : {}),
    ...(session.contextSnapshot ? { contextSnapshot: session.contextSnapshot } : {}),
    cwd: session.cwd,
    ...(session.rollingSummary ? { rollingSummary: session.rollingSummary } : {}),
    ...(session.messagesHiddenBefore ? { messagesHiddenBefore: session.messagesHiddenBefore } : {}),
    ...(session.historyActiveDate ? { historyActiveDate: session.historyActiveDate } : {}),
    ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeJsonlAtomic(filePath: string, rows: unknown[]): Promise<void> {
  await writeTextAtomic(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.conversation-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "session";
}

function isConversationSessionSummary(value: unknown): value is ConversationSessionSummary {
  const summary = value as Partial<ConversationSessionSummary>;
  return Boolean(
    summary
      && typeof summary.sessionId === "string"
      && typeof summary.title === "string"
      && typeof summary.messageCount === "number"
      && typeof summary.updatedAt === "number"
  );
}
