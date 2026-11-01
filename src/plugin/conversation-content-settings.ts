import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings, knowledgeCollectionTargets, knowledgeConversationLocation } from "../knowledge-base/folder-bindings";

/** Persist the first default save without marking the Knowledge setup as completed. */
export async function rememberConversationContentDirectory(plugin: Pick<CodexForObsidianPlugin, "settings" | "saveSettings">, directory: string): Promise<void> {
  const previous = plugin.settings.knowledgeBase.folderBindings;
  const location = knowledgeConversationLocation(previous);
  if (!location.createIfMissing || location.directory !== directory) return;
  const next = structuredClone(previous ?? emptyKnowledgeFolderBindings());
  next.collectionTargets = knowledgeCollectionTargets(next);
  next.collectionTargets.text = directory;
  next.conversationDirectoryPending = false;
  next.revision++;
  plugin.settings.knowledgeBase.folderBindings = next;
  try { await plugin.saveSettings(true); }
  catch (error) { if (plugin.settings.knowledgeBase.folderBindings === next) plugin.settings.knowledgeBase.folderBindings = previous; throw error; }
}
