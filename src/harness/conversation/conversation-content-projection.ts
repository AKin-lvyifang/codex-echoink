import type { ChatMessage } from "../../settings/settings";
import type { JsonValue } from "../contracts/conversation-v2";

/**
 * Projects the product-facing part of a knowledge-base card.
 *
 * Live cards deliberately retain execution diagnostics for the UI, while the
 * append-only Conversation store persists only stable product content. Every
 * durable revision comparison must reuse this projection so those two views
 * cannot disagree about whether the Conversation body changed.
 */
export function projectDurableKnowledgeBaseUi(
  message: Pick<ChatMessage, "knowledgeBaseUi">
): JsonValue | undefined {
  const payload = message.knowledgeBaseUi;
  if (!payload) return undefined;
  if (payload.kind === "maintain-run") {
    return cloneJsonValue({
      kind: payload.kind,
      mode: payload.mode,
      title: payload.title,
      subtitle: payload.subtitle,
      icon: payload.icon,
      phases: payload.phases
    });
  }
  return cloneJsonValue({
    kind: payload.kind,
    mode: payload.mode,
    status: payload.status,
    ...(Object.prototype.hasOwnProperty.call(payload, "failureCode")
      ? { failureCode: payload.failureCode ?? null }
      : {}),
    ...(payload.completion ? { completion: payload.completion } : {}),
    ...(payload.pendingSourceCount !== undefined
      ? { pendingSourceCount: payload.pendingSourceCount }
      : {}),
    ...(payload.warnings ? { warnings: payload.warnings } : {}),
    title: payload.title,
    reportPath: payload.reportPath,
    careItems: payload.careItems,
    sections: payload.sections
  });
}

function cloneJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
