import { knowledgeOutputLocation, normalizeKnowledgeDirectory, type KnowledgeFolderBindings, type KnowledgeOutputKind } from "./folder-bindings";

export class ConversationContentLocationError extends Error {
  constructor(readonly kind: KnowledgeOutputKind = "answer") {
    super(`${kind === "answer" ? "存为笔记的回答" : "从资料生成"}的保存位置不存在，去设置`);
    this.name = "ConversationContentLocationError";
  }
}
export interface ConversationContentDirectoryHost {
  kind(directory: string): Promise<"folder" | "file" | "missing">;
  createFolder(directory: string): Promise<void>;
  ready?(directory: string): Promise<void>;
}

/** Explicit manual save only. Never recreate a user's deleted or invalid destination. */
export async function ensureConversationContentDirectory(host: ConversationContentDirectoryHost, bindings: KnowledgeFolderBindings | null | undefined, kind: KnowledgeOutputKind = "answer"): Promise<string> {
  const location = knowledgeOutputLocation(bindings, kind);
  try { if (normalizeKnowledgeDirectory(location.directory) !== location.directory) throw new Error("invalid"); }
  catch { throw new ConversationContentLocationError(kind); }
  let directory = "";
  for (const segment of location.directory.split("/")) {
    directory = directory ? `${directory}/${segment}` : segment;
    const entryKind = await host.kind(directory);
    if (entryKind === "folder") continue;
    if (entryKind !== "missing" || !location.createIfMissing) throw new ConversationContentLocationError(kind);
    try { await host.createFolder(directory); }
    catch (error) { if (await host.kind(directory) !== "folder") throw error; }
  }
  if (location.createIfMissing) await host.ready?.(location.directory);
  return location.directory;
}
