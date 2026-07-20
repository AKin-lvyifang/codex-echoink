import {
  ConversationV2ContractError,
  validateConversationMetadataV2,
  type ConversationCommitV2,
  type ConversationKindV2,
  type ConversationMetadataV2
} from "../contracts/conversation-v2";

const SHELL_KEYS = [
  "conversationId",
  "title",
  "kind",
  "createdAt",
  "updatedAt"
] as const;

/**
 * Non-authoritative data.json DTO. Store hydration must replace every field.
 * Revision, context, commit, message count, payload, snapshot, summary, Raw,
 * backend, binding, usage, and terminal state are intentionally impossible to
 * represent.
 */
export interface ConversationShellV2 {
  conversationId: string;
  title: string;
  kind: ConversationKindV2;
  createdAt: number;
  updatedAt: number;
}

export const CONVERSATION_SHELL_V2_KEYS: readonly string[] = SHELL_KEYS;

export function projectConversationShellV2(
  value: ConversationCommitV2 | ConversationMetadataV2
): ConversationShellV2 {
  const metadata = isCommitLike(value) ? value.metadata : value;
  validateConversationMetadataV2(metadata);
  return {
    conversationId: metadata.conversationId,
    title: metadata.title,
    kind: metadata.kind,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  };
}

export const createConversationShellV2 = projectConversationShellV2;

export function validateConversationShellV2(
  value: unknown
): ConversationShellV2 {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ConversationV2ContractError(
      "invalid-record",
      "Conversation Shell V2 必须是普通对象"
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(SHELL_KEYS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ConversationV2ContractError(
        "unexpected-field",
        `Conversation Shell V2 含未知字段：${key}`
      );
    }
  }
  for (const key of SHELL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ConversationV2ContractError(
        "missing-field",
        `Conversation Shell V2 缺少字段：${key}`
      );
    }
  }
  if (
    typeof record.conversationId !== "string"
    || !record.conversationId.length
    || record.conversationId.trim() !== record.conversationId
    || record.conversationId.length > 512
    || hasUnsafeControlCharacter(record.conversationId)
  ) {
    throw new ConversationV2ContractError(
      "invalid-value",
      "Conversation Shell V2 conversationId 非法"
    );
  }
  if (
    typeof record.title !== "string"
    || !record.title.length
    || record.title.trim() !== record.title
    || record.title.length > 512
    || hasUnsafeControlCharacter(record.title)
  ) {
    throw new ConversationV2ContractError(
      "invalid-value",
      "Conversation Shell V2 title 非法"
    );
  }
  if (record.kind !== "chat" && record.kind !== "knowledge-base") {
    throw new ConversationV2ContractError(
      "invalid-value",
      "Conversation Shell V2 kind 非法"
    );
  }
  if (
    !isTimestamp(record.createdAt)
    || !isTimestamp(record.updatedAt)
    || record.updatedAt < record.createdAt
  ) {
    throw new ConversationV2ContractError(
      "invalid-value",
      "Conversation Shell V2 timestamp 非法"
    );
  }
  return record as unknown as ConversationShellV2;
}

function isCommitLike(
  value: ConversationCommitV2 | ConversationMetadataV2
): value is ConversationCommitV2 {
  return "metadata" in value;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  );
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127
    ) return true;
  }
  return false;
}
