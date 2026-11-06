import type { QueuedTurnOutcome } from "../ui/codex-view/runner-context";

/** Business tasks participate in conversations without teaching the runner their IDs. */
export interface ConversationTaskLifecycle {
  readonly ready: Promise<void>;
  ownsConversation(conversationId: string): boolean;
  beginTurn(conversationId: string): Promise<void>;
  settle(conversationId: string, outcome: QueuedTurnOutcome): Promise<void>;
  resume(conversationId: string): Promise<"model" | "restored">;
  stop(conversationId: string): Promise<void>;
  detach(conversationId: string): Promise<void>;
}
