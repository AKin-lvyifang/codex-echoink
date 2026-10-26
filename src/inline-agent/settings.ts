export interface InlineAgentSettings { trigger: string; nldConflictNoticeShown: boolean }
export function normalizeInlineAgentSettings(value: unknown): InlineAgentSettings {
  const raw = value && typeof value === "object" ? value as Partial<InlineAgentSettings> : {};
  return { trigger: validInlineTrigger(raw.trigger) ? raw.trigger : "@", nldConflictNoticeShown: raw.nldConflictNoticeShown === true };
}
export function validInlineTrigger(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length === 1 && !/[\s\p{L}\p{N}]/u.test(value);
}
