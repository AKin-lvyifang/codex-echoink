import type { DiaryOrganizerState } from "./types";

export function emptyDiaryOrganizerState(): DiaryOrganizerState {
  return { version: 1, enabledAt: null, startDate: null, documents: [], items: [] };
}

/** Fail closed rather than losing stable IDs after a damaged or newer state file. */
export function readDiaryOrganizerState(raw: unknown): DiaryOrganizerState {
  if (raw === null || raw === undefined) return emptyDiaryOrganizerState();
  if (typeof raw !== "object" || (raw as DiaryOrganizerState).version !== 1) throw new Error("日记整理进度格式不受支持，原文件已保留。请更新 EchoInk 后重试。");
  const value = raw as DiaryOrganizerState;
  if (!Array.isArray(value.documents) || !Array.isArray(value.items)
    || value.documents.some(doc => !doc || typeof doc.id !== "string" || typeof doc.path !== "string" || typeof doc.fingerprint !== "string")
    || value.items.some(item => !item || typeof item.id !== "string" || typeof item.documentId !== "string" || !item.candidate
      || !["pending", "review", "written", "ignored", "undone"].includes(item.status))) throw new Error("日记整理进度已损坏，原文件已保留。如问题持续，请点击“上报问题”。");
  const state = structuredClone(value);
  for (const item of state.items) {
    // Older receipts have only updatedAt. Freeze it once so future scans do not
    // make historical writes appear new on the home screen.
    if (item.written && item.writtenAt === undefined) item.writtenAt = item.updatedAt;
  }
  return state;
}
