export type ComposerPrimaryAction = "send" | "enqueue" | "resume-queue" | "stop-turn" | "cancel-knowledge-task";

export interface ComposerPrimaryActionState {
  viewRunning: boolean;
  viewRunKind?: "chat" | "knowledge-base" | "";
  knowledgeTaskRunning: boolean;
  hasDraft?: boolean;
  hasQueuedItems?: boolean;
}

export interface ComposerRuntimeActionState {
  viewRunning: boolean;
  viewRunKind?: "chat" | "knowledge-base" | "";
  globalKnowledgeTaskRunning: boolean;
  hasDraft?: boolean;
  hasQueuedItems?: boolean;
}

export function composerStateForRuntimeState(state: ComposerRuntimeActionState): ComposerPrimaryActionState {
  return {
    viewRunning: state.viewRunning,
    viewRunKind: state.viewRunKind,
    knowledgeTaskRunning: state.globalKnowledgeTaskRunning,
    hasDraft: state.hasDraft,
    hasQueuedItems: state.hasQueuedItems
  };
}

export function composerPrimaryActionForRuntimeState(state: ComposerRuntimeActionState): ComposerPrimaryAction {
  return composerPrimaryActionForState(composerStateForRuntimeState(state));
}

export function composerIsBusy(state: ComposerPrimaryActionState): boolean {
  return state.viewRunning || state.knowledgeTaskRunning;
}

export function composerPrimaryActionForState(state: ComposerPrimaryActionState): ComposerPrimaryAction {
  if (composerIsBusy(state) && state.hasDraft) return "enqueue";
  if (state.viewRunning && state.viewRunKind !== "knowledge-base") return "stop-turn";
  if (state.knowledgeTaskRunning) return "cancel-knowledge-task";
  if (state.viewRunning) return "stop-turn";
  if (state.hasQueuedItems && state.hasDraft) return "enqueue";
  if (state.hasQueuedItems) return "resume-queue";
  return "send";
}
