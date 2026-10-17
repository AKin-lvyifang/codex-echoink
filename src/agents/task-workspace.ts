import { sanitizeStoredPiDocumentReplay, type StoredAttachment } from "../settings/settings";
import { GENERAL_ASSISTANT_ID } from "./types";
import { normalizeAgentId } from "./registry";

export type TaskPage = { kind: "list"; agentId: string } | { kind: "detail"; taskId: string };
export interface TaskDraft {
  text: string;
  attachments: StoredAttachment[];
  prefillSource?: string;
}
export interface TaskWorkspace {
  page: TaskPage;
  newTaskDrafts: Record<string, TaskDraft>;
  replyDrafts: Record<string, TaskDraft>;
}

export function defaultTaskWorkspace(): TaskWorkspace {
  return { page: { kind: "list", agentId: GENERAL_ASSISTANT_ID }, newTaskDrafts: {}, replyDrafts: {} };
}

export function normalizeTaskWorkspace(value: unknown): TaskWorkspace {
  const raw = record(value);
  const page = record(raw?.page);
  return {
    page: page?.kind === "detail" && typeof page.taskId === "string" && page.taskId.trim()
      ? { kind: "detail", taskId: page.taskId.trim() }
      : { kind: "list", agentId: normalizeAgentId(page?.agentId) ?? GENERAL_ASSISTANT_ID },
    newTaskDrafts: normalizeDrafts(raw?.newTaskDrafts),
    replyDrafts: normalizeDrafts(raw?.replyDrafts)
  };
}

/** A pure page/draft change. It cannot create a Conversation, Pi Session, or run. */
export function prefillNewTask(workspace: TaskWorkspace, agentId: string, draft: TaskDraft): { workspace: TaskWorkspace; accepted: boolean } {
  if (!normalizeAgentId(agentId)) throw new Error("agent_id_invalid");
  const previous = Object.hasOwn(workspace.newTaskDrafts, agentId) ? workspace.newTaskDrafts[agentId] : undefined;
  const accepted = !previous || (!previous.text.trim() && previous.attachments.length === 0);
  return {
    accepted,
    workspace: { ...workspace, page: { kind: "list", agentId }, newTaskDrafts: accepted ? { ...workspace.newTaskDrafts, [agentId]: structuredClone(draft) } : workspace.newTaskDrafts }
  };
}

function normalizeDrafts(value: unknown): Record<string, TaskDraft> {
  return Object.fromEntries(Object.entries(record(value) ?? {}).flatMap(([id, value]) => {
    const draft = record(value);
    if (!id.trim() || !draft) return [];
    const attachments: StoredAttachment[] = [];
    for (const value of Array.isArray(draft.attachments) ? draft.attachments : []) {
      const item = record(value);
      if (!item || (item.type !== "file" && item.type !== "image") || typeof item.name !== "string" || typeof item.path !== "string") continue;
      const documentReplay = sanitizeStoredPiDocumentReplay({ draft: [item.documentReplay] })?.draft?.[0];
      attachments.push({ type: item.type, name: item.name, path: item.path,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.sizeBytes === "number" && item.sizeBytes >= 0 ? { sizeBytes: item.sizeBytes } : {}),
        ...(item.availability === "available" || item.availability === "unavailable" ? { availability: item.availability } : {}),
        ...(documentReplay ? { documentReplay } : {}) });
    }
    return [[id, { text: typeof draft.text === "string" ? draft.text : "", attachments, ...(typeof draft.prefillSource === "string" ? { prefillSource: draft.prefillSource } : {}) }]];
  }));
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
