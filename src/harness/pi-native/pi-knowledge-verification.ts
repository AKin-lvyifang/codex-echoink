export const PI_KNOWLEDGE_VERIFICATION_ENTRY_TYPE = "echoink.knowledge-verification.v1";

export interface PiKnowledgeVerificationSkippedRecord {
  readonly schemaVersion: 1;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly assistantEntryId: string;
  readonly reason: "knowledge_permission_revoked";
  readonly referenceIds: readonly string[];
}

/** Restore only this Session's explicit verification outcome, never source bodies. */
export function knowledgeVerificationFromSessionEntry(
  entry: unknown,
  piSessionId: string
): Readonly<PiKnowledgeVerificationSkippedRecord> | null {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PI_KNOWLEDGE_VERIFICATION_ENTRY_TYPE) return null;
  const data = entry.data;
  if (!isRecord(data) || data.schemaVersion !== 1 || !nonemptyString(piSessionId)
    || data.piSessionId !== piSessionId || !nonemptyString(data.productRunId) || !nonemptyString(data.assistantEntryId)
    || data.reason !== "knowledge_permission_revoked" || !Array.isArray(data.referenceIds)
    || data.referenceIds.length === 0 || !data.referenceIds.every(nonemptyString)) return null;
  return Object.freeze({
    schemaVersion: 1,
    piSessionId,
    productRunId: data.productRunId,
    assistantEntryId: data.assistantEntryId,
    reason: data.reason,
    referenceIds: Object.freeze([...data.referenceIds])
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
