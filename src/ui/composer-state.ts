export type ComposerPrimaryAction = "send" | "stop-turn" | "cancel-knowledge-task";

export interface ComposerPrimaryActionState {
  viewRunning: boolean;
  knowledgeTaskRunning: boolean;
}

export function composerIsBusy(state: ComposerPrimaryActionState): boolean {
  return state.viewRunning || state.knowledgeTaskRunning;
}

export function composerPrimaryActionForState(state: ComposerPrimaryActionState): ComposerPrimaryAction {
  if (state.knowledgeTaskRunning) return "cancel-knowledge-task";
  if (state.viewRunning) return "stop-turn";
  return "send";
}
