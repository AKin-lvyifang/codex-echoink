import { getDesktopCrypto } from "../../platform/desktop-crypto";
import type { ChatMessage } from "../../settings/settings";
import { projectDurableKnowledgeBaseUi } from "./conversation-content-projection";

const { createHash } = getDesktopCrypto();

export function createConversationProductMessageRevision(
  message: ChatMessage
): string {
  return `sha256:${stableDigest(conversationProductMessageRecord(message))}`;
}

function conversationProductMessageRecord(message: ChatMessage): unknown {
  const knowledgeBaseUi = projectDurableKnowledgeBaseUi(message);
  const presentation = {
    schemaVersion: 1,
    ...(message.itemType !== undefined
      ? { itemType: message.itemType }
      : {}),
    ...(message.title !== undefined ? { title: message.title } : {}),
    ...(message.status !== undefined ? { status: message.status } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.attachments !== undefined
      ? { attachments: message.attachments }
      : {}),
    ...(message.images !== undefined ? { images: message.images } : {}),
    ...(message.files !== undefined ? { files: message.files } : {}),
    ...(message.citations !== undefined
      ? { citations: message.citations }
      : {}),
    ...(message.diffSummary !== undefined
      ? { diffSummary: message.diffSummary }
      : {}),
    ...(knowledgeBaseUi !== undefined
      ? { knowledgeBaseUi }
      : {})
  };
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId ?? null,
    previewText: message.previewText ?? null,
    raw: message.rawRef
      ? {
        ref: message.rawRef,
        size: nonNegativeInteger(message.rawSize) ?? 0,
        lines: nonNegativeInteger(message.rawLines) ?? 0,
        truncatedForPreview: message.rawTruncatedForPreview === true
      }
      : null,
    presentation: Object.keys(presentation).length === 1
      ? null
      : presentation,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null
  };
}

function stableDigest(value: unknown): string {
  const serialized = JSON.stringify(stableJsonValue(value));
  if (serialized === undefined) {
    throw new Error("Conversation message is not JSON serializable");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : stableJsonValue(item));
  }
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = stableJsonValue(value[key]);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}
