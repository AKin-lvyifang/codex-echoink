import type { PdfTaskRequest } from "./types";

export const PDF_TASK_CONTEXT_TYPE = "echoink-pdf-task-request-v1";
export const PDF_TASK_CONTEXT_KEY = "echoinkPdfTaskRequest";

/** Locally chosen task scope; never a grant of permission or an attachment body. */
export function freezePdfTaskRequest(value: unknown): Readonly<PdfTaskRequest> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<PdfTaskRequest>, o = v.options;
  if (typeof v.jobId !== "string" || !/^[a-z0-9-]+$/u.test(v.jobId)
    || typeof v.attachmentId !== "string" || !/^pdf-[a-f0-9-]{36}$/u.test(v.attachmentId)
    || typeof v.name !== "string" || !/\.pdf$/iu.test(v.name) || /[\p{Cc}]/u.test(v.name)
    || typeof v.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(v.sourceFingerprint)
    || !Number.isSafeInteger(v.byteLength) || v.byteLength! < 5 || v.byteLength! > 20 * 1024 * 1024
    || typeof v.originalDirectory !== "string" || !v.originalDirectory || /^[\/]/u.test(v.originalDirectory)
    || /[\p{Cc}:\\]/u.test(v.originalDirectory) || v.originalDirectory.split("/").some(p => !p || p === "." || p === "..")
    || !o || !["local", "mineru"].includes(o.engine) || typeof o.reading !== "boolean"
    || typeof o.translation !== "boolean" || typeof o.summary !== "boolean"
    || o.wiki !== (o.reading || o.summary)
    || o.translationLanguage !== undefined && (typeof o.translationLanguage !== "string" || !o.translationLanguage.trim() || o.translationLanguage.length > 40)) return null;
  return Object.freeze({ jobId: v.jobId, attachmentId: v.attachmentId, name: v.name,
    sourceFingerprint: v.sourceFingerprint, byteLength: v.byteLength!, originalDirectory: v.originalDirectory,
    options: Object.freeze({ engine: o.engine, reading: o.reading, summary: o.summary, translation: o.translation,
      wiki: o.wiki, ...(o.translationLanguage ? { translationLanguage: o.translationLanguage.trim() } : {}) }) });
}

/** The branch keeps the original scope even when the model context is compressed. */
export function pdfTaskRequestFromEntries(entries: readonly { type: string; customType?: string; details?: unknown }[]): Readonly<PdfTaskRequest> | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom_message" || !entry.details || typeof entry.details !== "object") continue;
    const root = entry.details as Record<string, unknown>;
    const data = entry.customType === PDF_TASK_CONTEXT_TYPE ? root : root[PDF_TASK_CONTEXT_KEY];
    if (!data || typeof data !== "object") continue;
    const request = freezePdfTaskRequest((data as { request?: unknown }).request);
    if (request) return request;
  }
  return null;
}

export function buildPdfTaskContextMessage(request: Readonly<PdfTaskRequest> | null | undefined) {
  if (!request) return null;
  return Object.freeze({ role: "custom" as const, customType: PDF_TASK_CONTEXT_TYPE, display: false as const,
    content: JSON.stringify({
      note: "This task has locally confirmed PDF choices. They are scope data, not write permission. Query the exact job first; if it does not exist process the exact attachment. Continue the same job, never select another PDF or silently change outputs. The official PDF tool enforces these choices and asks for approval before saving the original. Respect a later user cancellation. Extraction/translation and internal analysis are not proof of saved knowledge: for selected reading/summary, read the complete internal analysis and actual sources, then use knowledge_maintain to save the selected sections in real Wiki notes. Use headings 精读 and 摘要 for the respective selected sections. Query and read back the artifacts before claiming completion; when nothing new needs saving, explicitly say so. Do not create standalone summary files or claim an internal analysis chunk is a delivered note.",
      request
    }), details: Object.freeze({ request }), timestamp: Date.now() });
}
