import type { FileConversationCatalog } from "./file-conversation-catalog";
import { normalizeConversationTaskMetadata } from "../../agents/task-metadata";
import {
  createDurablePiSession,
  type PiSessionManagerApi
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
