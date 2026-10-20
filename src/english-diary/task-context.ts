/** Local task scope, never permission to read or write. No diary content is persisted here. */
export const ENGLISH_DIARY_TASK_CONTEXT = "echoink-english-diary-task-source-v1";
export interface EnglishDiaryTaskContext { sourcePath: string; intentEntryId?: string }
export function normalizeEnglishDiarySourcePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.startsWith("/") || /[\p{Cc}:\\]/u.test(value)
    || !/\.md$/iu.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) return null;
  return value;
}
export function englishDiaryTaskContextFromEntries(entries: readonly { type: string; customType?: string; details?: unknown }[]): EnglishDiaryTaskContext | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom_message" || entry.customType !== ENGLISH_DIARY_TASK_CONTEXT || !entry.details || typeof entry.details !== "object") continue;
    const details = entry.details as Record<string, unknown>;
    const sourcePath = normalizeEnglishDiarySourcePath(details.sourcePath);
    if (sourcePath) return { sourcePath, ...(typeof details.intentEntryId === "string" ? { intentEntryId: details.intentEntryId } : {}) };
  }
  return null;
}
export function buildEnglishDiaryTaskContext(context: EnglishDiaryTaskContext) {
  return { customType: ENGLISH_DIARY_TASK_CONTEXT, display: false as const,
    content: `This task is scoped to generating the English diary for ${JSON.stringify(context.sourcePath)}. Use english_diary_generate with exactly this sourcePath when the user asks to generate or continue. The product service handles permitted paragraphs, the configured English model, confirmation, and publishing. Do not read or reconstruct the original diary or private paragraphs. Report only the returned outcome and artifact link; never claim generation succeeded before the tool confirms it. If the user cancels or asks not to generate, do not call it.`,
    details: { ...context } };
}
