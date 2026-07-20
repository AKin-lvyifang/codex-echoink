import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const CONVERSATION_STORE_V1_EXPORTS_DIRECTORY =
  "conversation-v1-exports";
export const CONVERSATION_STORE_V1_EXPORT_GENERATION_PREFIX =
  "export-";
export const CONVERSATION_STORE_V1_EXPORT_GENERATION_PATTERN =
  /^export-[a-f0-9]{64}$/;

export function conversationStoreV1LegacyRoot(
  storageRootPath: string
): string {
  return path.join(path.resolve(storageRootPath), "conversations");
}

export function conversationStoreV1ExportsRoot(
  storageRootPath: string
): string {
  return path.join(
    path.resolve(storageRootPath),
    CONVERSATION_STORE_V1_EXPORTS_DIRECTORY
  );
}

export function conversationStoreV1ExportGenerationRoot(
  storageRootPath: string,
  generationId: string
): string {
  assertConversationStoreV1ExportGenerationId(generationId);
  return path.join(
    conversationStoreV1ExportsRoot(storageRootPath),
    generationId
  );
}

export function conversationStoreV1ExportStoreRoot(
  storageRootPath: string,
  generationId: string
): string {
  return path.join(
    conversationStoreV1ExportGenerationRoot(
      storageRootPath,
      generationId
    ),
    "store"
  );
}

export async function assertConversationStoreV1ExportDirectoryChain(
  storageRootPath: string,
  generationId: string,
  options: { requireStore?: boolean } = {}
): Promise<void> {
  const directories = [
    {
      label: "exports root",
      absolutePath: conversationStoreV1ExportsRoot(storageRootPath)
    },
    {
      label: "generation root",
      absolutePath: conversationStoreV1ExportGenerationRoot(
        storageRootPath,
        generationId
      )
    },
    ...(options.requireStore
      ? [{
          label: "store root",
          absolutePath: conversationStoreV1ExportStoreRoot(
            storageRootPath,
            generationId
          )
        }]
      : [])
  ];
  for (const directory of directories) {
    const stat = await fsp.lstat(directory.absolutePath).catch((error) => {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new Error(
          `Conversation V1 export ${directory.label} is missing`
        );
      }
      throw error;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Conversation V1 export ${directory.label} must be a plain directory`
      );
    }
  }
}

export function assertConversationStoreV1ExportGenerationId(
  value: string
): void {
  if (!CONVERSATION_STORE_V1_EXPORT_GENERATION_PATTERN.test(value)) {
    throw new Error("Conversation V1 export generation ID is invalid");
  }
}
