import type CodexForObsidianPlugin from "../main";
import { emptyKnowledgeFolderBindings, knowledgeCollectionTargets, knowledgeOutputLocation, type KnowledgeOutputKind } from "../knowledge-base/folder-bindings";

/** Persist the first default save without marking the Knowledge setup as completed. */
export async function rememberConversationContentDirectory(plugin: Pick<CodexForObsidianPlugin, "settings" | "saveSettings">, directory: string, kind: KnowledgeOutputKind = "answer"): Promise<void> {
  const previous = plugin.settings.knowledgeBase.folderBindings;
  const location = knowledgeOutputLocation(previous, kind);
  if (!location.createIfMissing || location.directory !== directory) return;
  const next = structuredClone(previous ?? emptyKnowledgeFolderBindings());
  next.answerDirectoryPending = knowledgeOutputLocation(next, "answer").createIfMissing;
  next.generationDirectoryPending = knowledgeOutputLocation(next, "generation").createIfMissing;
  next.collectionTargets = knowledgeCollectionTargets(next);
  next.collectionTargets[kind] = directory;
  if (kind === "answer") next.answerDirectoryPending = false;
  else next.generationDirectoryPending = false;
  next.revision++;
  plugin.settings.knowledgeBase.folderBindings = next;
  try { await plugin.saveSettings(true); }
  catch (error) { if (plugin.settings.knowledgeBase.folderBindings === next) plugin.settings.knowledgeBase.folderBindings = previous; throw error; }
}
