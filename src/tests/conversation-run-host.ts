import { applyConversationTaskMetadata, patchConversationTaskMetadata, type ConversationTaskMetadataPatch } from "../agents/task-metadata";
import type CodexForObsidianPlugin from "../main";
import { ConversationRunService } from "../plugin/conversation-run-service";
import type { StoredSession } from "../settings/settings";

/** Legacy UI fixtures use the production run owner and an in-memory Catalog port. */
export function attachTestConversationRunService(plugin: any): ConversationRunService {
  if (plugin.getConversationRunService) return plugin.getConversationRunService();
  const service = new ConversationRunService(plugin as CodexForObsidianPlugin);
  plugin.getConversationRunService = () => service;
  plugin.saveSettings ??= async () => undefined;
  plugin.setPiConversationTaskMetadata ??= async (id: string, patch: ConversationTaskMetadataPatch) => {
    const session = plugin.settings.sessions?.find((candidate: StoredSession) => candidate.id === id);
    if (!session) throw new Error(`Missing fixture Conversation ${id}`);
    applyConversationTaskMetadata(session, patchConversationTaskMetadata(session, patch));
  };
  return service;
}
