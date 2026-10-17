import type { QueuedTurnItem } from "../ui/turn-queue";
import { selectionAnnotationsMatch } from "../types/selection-annotations";
import type { EchoInkResource } from "../resources/types";
import type { SelectionAnnotation } from "../types/selection-annotations";
import type { NoteMentionSelection } from "../ui/codex-view/note-mentions";
import { sanitizeStoredPiDocumentReplay, type StoredAttachment } from "../settings/settings";
import { GENERAL_ASSISTANT_ID } from "./types";
import { normalizeAgentId } from "./registry";

export type TaskPage = { kind: "list"; agentId: string } | { kind: "detail"; taskId: string };
export interface TaskDraft {
  text: string;
  attachments: StoredAttachment[];
  prefillSource?: string;
  noteMentions?: NoteMentionSelection[];
  annotations?: SelectionAnnotation[];
  selectedSkill?: EchoInkResource | null;
  selectedProviderSettingsId?: string;
  selectedModel?: string;
  selectedPermission?: "read-only" | "workspace-write" | "danger-full-access";
  selectedMode?: "agent" | "plan";
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
  const accepted = !previous || (!previous.text.trim() && previous.attachments.length === 0 && !previous.noteMentions?.length && !previous.annotations?.length && !previous.selectedSkill);
  return {
    accepted,
    workspace: { ...workspace, page: { kind: "list", agentId }, newTaskDrafts: accepted ? { ...workspace.newTaskDrafts, [agentId]: normalizeDrafts({ [agentId]: draft })[agentId] } : workspace.newTaskDrafts }
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
    const snapshot: TaskDraft = { text: typeof draft.text === "string" ? draft.text : "", attachments, ...(typeof draft.prefillSource === "string" ? { prefillSource: draft.prefillSource } : {}),
      noteMentions: (Array.isArray(draft.noteMentions) ? draft.noteMentions : []).flatMap(value => {
        const mention = record(value);
        return typeof mention?.vaultRelativePath === "string" && typeof mention.fileName === "string"
          ? [{ vaultRelativePath: mention.vaultRelativePath, fileName: mention.fileName }] : [];
      }),
      annotations: normalizeAnnotations(draft.annotations),
      selectedSkill: normalizeDraftSkill(draft.selectedSkill),
      ...(typeof draft.selectedProviderSettingsId === "string" ? { selectedProviderSettingsId: draft.selectedProviderSettingsId } : {}),
      ...(typeof draft.selectedModel === "string" ? { selectedModel: draft.selectedModel } : {}),
      ...(["read-only", "workspace-write", "danger-full-access"].includes(draft.selectedPermission as string) ? { selectedPermission: draft.selectedPermission as TaskDraft["selectedPermission"] } : {}),
      ...(["agent", "plan"].includes(draft.selectedMode as string) ? { selectedMode: draft.selectedMode as TaskDraft["selectedMode"] } : {}) };
    for (const key of ["noteMentions", "annotations", "selectedSkill"] as const) if (!Object.hasOwn(draft, key)) delete snapshot[key];
    return [[id, snapshot]];
  }));
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeDraftSkill(value: unknown): EchoInkResource | null {
  const skill = record(value);
  if (!skill || skill.kind !== "skill" || typeof skill.id !== "string" || typeof skill.name !== "string") return null;
  return { id: skill.id, kind: "skill", source: skill.source === "manual" ? "manual" : "echoink-local",
    name: skill.name, description: typeof skill.description === "string" ? skill.description : "", enabled: skill.enabled === true,
    bridgeMode: "prompt-only", ...(typeof skill.contentPath === "string" ? { contentPath: skill.contentPath } : {}),
    ...(typeof record(skill.metadata)?.resourceId === "string" ? { metadata: { resourceId: record(skill.metadata)!.resourceId } } : {}) };
}
function normalizeAnnotations(value: unknown): SelectionAnnotation[] {
  return (Array.isArray(value) ? value : []).flatMap(value => {
    const item = record(value), anchor = record(item?.anchor);
    if (!item || !anchor || typeof item.id !== "string" || typeof item.number !== "number"
      || typeof item.selectedText !== "string" || typeof item.vaultRelativePath !== "string" || typeof item.fileName !== "string"
      || (anchor.mode !== "editor" && anchor.mode !== "reading") || typeof anchor.from !== "number" || typeof anchor.to !== "number") return [];
    return [{ id: item.id, number: item.number, selectedText: item.selectedText, vaultRelativePath: item.vaultRelativePath, fileName: item.fileName,
      appliedActions: (Array.isArray(item.appliedActions) ? item.appliedActions : []).filter((v): v is string => typeof v === "string"),
      anchor: { mode: anchor.mode, from: anchor.from, to: anchor.to, before: typeof anchor.before === "string" ? anchor.before : "", after: typeof anchor.after === "string" ? anchor.after : "",
        ...(typeof anchor.sectionStart === "number" ? { sectionStart: anchor.sectionStart } : {}), ...(typeof anchor.sectionEnd === "number" ? { sectionEnd: anchor.sectionEnd } : {}),
        ...(record(anchor.source) && typeof record(anchor.source)!.from === "number" && typeof record(anchor.source)!.to === "number" && typeof record(anchor.source)!.text === "string"
          ? { source: { from: record(anchor.source)!.from as number, to: record(anchor.source)!.to as number, text: record(anchor.source)!.text as string,
              before: typeof record(anchor.source)!.before === "string" ? record(anchor.source)!.before as string : "", after: typeof record(anchor.source)!.after === "string" ? record(anchor.source)!.after as string : "" } } : {}),
        ...(anchor.invalid === true ? { invalid: true } : {}), ...(anchor.unresolved === true ? { unresolved: true } : {}) } }];
  });
}

/** Consume only the accepted snapshot, including when its originating View has closed. */
export function consumeAcceptedTaskDraft(workspace: TaskWorkspace, key: string, item: Readonly<QueuedTurnItem>): boolean {
  const drafts = key.startsWith("agent:") ? workspace.newTaskDrafts : workspace.replyDrafts;
  const id = key.startsWith("agent:") ? key.slice(6) : key;
  const draft = drafts[id];
  if (!draft || (item.composerTextSnapshot === undefined ? draft.text.trim() !== item.text : draft.text !== item.composerTextSnapshot)
    || !selectionAnnotationsMatch(draft.annotations ?? [], item.selectionAnnotations ?? [])
    || (draft.selectedSkill?.id ?? null) !== (item.skill?.id ?? null)
    || (draft.noteMentions?.length ?? 0) !== (item.noteMentions?.length ?? 0)
    || (draft.noteMentions ?? []).some((mention, index) => mention.vaultRelativePath !== item.noteMentions?.[index].vaultRelativePath)
    || draft.attachments.length !== item.attachments.length
    || draft.attachments.some((attachment, index) => { const other = item.attachments[index]; return attachment.path !== other.path || attachment.type !== other.type || attachment.name !== other.name || attachment.mimeType !== other.mimeType || attachment.sizeBytes !== other.sizeBytes; })) return false;
  drafts[id] = { text: "", attachments: [] }; return true;
}
