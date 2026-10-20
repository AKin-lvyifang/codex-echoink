import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeKnowledgeDirectory } from "../../knowledge-base/folder-bindings";
import type { PiSessionBranchEntryView } from "./pi-chat-ui-projector";
import { assertPiSessionAppendsDurable, persistPiActiveLeaf } from "./pi-session-durability";

export const PI_ANSWER_SAVE_ENTRY_TYPE = "echoink.answer-saved.v1";

/** Paths belong to the selected Session Branch, keyed by Pi's stable assistant Entry id. */
export function savedAnswerNotePaths(
  entries: readonly PiSessionBranchEntryView[],
  piSessionId: string
): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_ANSWER_SAVE_ENTRY_TYPE) continue;
    const data = entry.data as Record<string, unknown> | null;
    if (!data || data.schemaVersion !== 1 || data.piSessionId !== piSessionId
      || typeof data.assistantEntryId !== "string" || !data.assistantEntryId
      || typeof data.path !== "string" || !validNotePath(data.path)) continue;
    if (!paths.has(data.assistantEntryId)) paths.set(data.assistantEntryId, data.path);
  }
  return paths;
}

/** Manual, Provider-free receipt; no settings cache or second storage location. */
export function appendSavedAnswerNote(input: {
  sessionManager: SessionManager;
  sessionRoot: string;
  piSessionId: string;
  assistantEntryId: string;
  path: string;
}): string {
  const { sessionManager, sessionRoot, piSessionId, assistantEntryId, path } = input;
  const branch = sessionManager.getBranch();
  const target = branch.find(entry => entry.id === assistantEntryId);
  if (sessionManager.getSessionId() !== piSessionId || target?.type !== "message"
    || target.message.role !== "assistant" || !validNotePath(path)) {
    throw new Error("无法将保存状态关联到原回答。");
  }
  const existing = savedAnswerNotePaths(branch, piSessionId).get(assistantEntryId);
  if (existing && existing !== path) throw new Error(`这条回答已存为 ${existing}`);
  if (!existing) {
    const id = sessionManager.appendCustomEntry(PI_ANSWER_SAVE_ENTRY_TYPE, {
      schemaVersion: 1, piSessionId, assistantEntryId, path
    });
    assertPiSessionAppendsDurable({ sessionRoot, sessionManager, expectedEntryIds: [id] });
  }
  // Also retry the checkpoint if a prior append succeeded but its checkpoint failed.
  persistPiActiveLeaf({ sessionRoot, sessionManager });
  return path;
}

function validNotePath(path: string): boolean {
  try {
    return path.endsWith(".md") && normalizeKnowledgeDirectory(path) === path;
  } catch {
    return false;
  }
}
