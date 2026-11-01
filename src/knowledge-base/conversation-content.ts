import { knowledgeConversationLocation, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";

export class ConversationContentLocationError extends Error {
  constructor() { super("对话栏内容的保存位置不存在，去设置"); this.name = "ConversationContentLocationError"; }
}
export interface ConversationContentDirectoryHost {
  kind(directory: string): Promise<"folder" | "file" | "missing">;
  createFolder(directory: string): Promise<void>;
  ready?(directory: string): Promise<void>;
}

/** Explicit manual save only. Never recreate a user's deleted or invalid destination. */
export async function ensureConversationContentDirectory(host: ConversationContentDirectoryHost, bindings: KnowledgeFolderBindings | null | undefined): Promise<string> {
  const location = knowledgeConversationLocation(bindings);
  try { if (normalizeKnowledgeDirectory(location.directory) !== location.directory) throw new Error("invalid"); }
  catch { throw new ConversationContentLocationError(); }
  let directory = "";
  for (const segment of location.directory.split("/")) {
    directory = directory ? `${directory}/${segment}` : segment;
    const kind = await host.kind(directory);
    if (kind === "folder") continue;
    if (kind !== "missing" || !location.createIfMissing) throw new ConversationContentLocationError();
    try { await host.createFolder(directory); }
    catch (error) { if (await host.kind(directory) !== "folder") throw error; }
  }
  if (location.createIfMissing) await host.ready?.(location.directory);
  return location.directory;
}
