import type { ConversationTaskMetadata } from "../agents/task-metadata";

/** Stable settings projection used by the current Pi Conversation UI. */
export interface EchoInkConversationSessionShell<
  TMessage,
  TContextLedger = unknown,
  TTokenUsage = unknown
> extends ConversationTaskMetadata {
  id: string;
  title: string;
  piSessionId?: string;
  defaultMemoryMode?: "normal" | "no_memory";
  defaultSkillId?: string;
  journalDirectory?: string;
  bodyAuthority?: "pi_session_only";
  cwd: string;
  messages: TMessage[];
  tokenUsage?: TTokenUsage;
  /** Cache only; Pi Session remains authoritative. */
  contextLedger?: TContextLedger;
  /** Positive timestamp for the latest completed answer not yet opened. */
  unreadAnswerAt?: number;
  createdAt: number;
  updatedAt: number;
}
