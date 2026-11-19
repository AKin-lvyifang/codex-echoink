import type { FileConversationCatalog } from "./file-conversation-catalog";
import { normalizeConversationTaskMetadata } from "../../agents/task-metadata";
import {
  assertPiSessionAppendsDurable,
  createDurablePiSession,
  persistPiActiveLeaf,
  type PiSessionManagerApi,
  type PiSessionManagerLike
} from "./pi-session-durability";
import type { PiConversationCatalogEntry } from "./contracts";
import type {
  CreatePiNativeConversationInput
} from "./pi-native-conversation-runtime";

export interface PiLocalConversationStore {
  readonly catalog: FileConversationCatalog;
  readonly sessionApi: PiSessionManagerApi;
}

/**
 * Creates a durable Conversation without initializing an AgentSession or
 * requiring Provider configuration.
 */
export async function createPiLocalConversation(
  store: PiLocalConversationStore,
  input: CreatePiNativeConversationInput
): Promise<Readonly<PiConversationCatalogEntry>> {
  const existing = await store.catalog.get(input.conversationId);
  if (existing) return existing;
  const createdAt = input.createdAt ?? Date.now();
  const durable = createDurablePiSession({
    api: store.sessionApi,
    sessionRoot: store.catalog.sessionRootPath,
    cwd: input.cwd
  });
  if (input.seedMessages?.length) seedPiSessionHistory(store.catalog.sessionRootPath, durable.sessionManager, input.seedMessages);
  return await store.catalog.upsert({
    conversationId: input.conversationId,
    piSessionId: durable.piSessionId,
    vaultId: store.catalog.vaultId,
    title: input.title,
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    ...normalizeConversationTaskMetadata(input),
    taskMetadataUpdatedAt: createdAt,
    status: "active",
    defaultMemoryMode: input.defaultMemoryMode ?? "normal",
    ...(input.defaultSkillId ? { defaultSkillId: input.defaultSkillId } : {}),
    ...(input.journalDirectory
      ? { journalDirectory: input.journalDirectory }
      : {}),
    createdAt,
    updatedAt: createdAt,
    sessionFile: durable.sessionFile
  });
}

/**
 * Writes a finished transcript (e.g. one continued from another device) as ordinary Pi history: the chat panel shows it
 * and the model reads it as earlier turns. Pi defers the file until an assistant entry exists, so a seed needs one.
 */
function seedPiSessionHistory(sessionRoot: string, sessionManager: PiSessionManagerLike, messages: NonNullable<CreatePiNativeConversationInput["seedMessages"]>): void {
  if (!messages.some(message => message.role === "assistant")) throw new Error("seed_history_requires_assistant");
  const expectedEntryIds = messages.map(message => sessionManager.appendMessage(message.role === "user"
    ? { role: "user", content: [{ type: "text", text: message.text }], timestamp: message.at }
    : { role: "assistant", content: [{ type: "text", text: message.text }], api: "echoink-local", provider: "echoink-local", model: "synced-history",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: message.at }));
  assertPiSessionAppendsDurable({ sessionRoot, sessionManager, expectedEntryIds });
  persistPiActiveLeaf({ sessionRoot, sessionManager });
}
