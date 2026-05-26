export type ComposerPrimaryAction = "send" | "enqueue" | "resume-queue" | "stop-turn" | "cancel-knowledge-task";

export interface ComposerPrimaryActionState {
  viewRunning: boolean;
  knowledgeTaskRunning: boolean;
  hasDraft?: boolean;
  hasQueuedItems?: boolean;
}

export function composerIsBusy(state: ComposerPrimaryActionState): boolean {
  return state.viewRunning || state.knowledgeTaskRunning;
}

export function composerPrimaryActionForState(state: ComposerPrimaryActionState): ComposerPrimaryAction {
  if (composerIsBusy(state) && state.hasDraft) return "enqueue";
  if (state.knowledgeTaskRunning) return "cancel-knowledge-task";
  if (state.viewRunning) return "stop-turn";
  if (state.hasQueuedItems && state.hasDraft) return "enqueue";
  if (state.hasQueuedItems) return "resume-queue";
  return "send";
}
