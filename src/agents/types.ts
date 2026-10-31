import type { AgentAvatarState } from "../harness/memory/agent-identity-model";

export const GENERAL_ASSISTANT_ID = "sol";
export const AGENT_MODULE_IDS = [
  "journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"
] as const;
export type AgentModuleId = typeof AGENT_MODULE_IDS[number];
export type AgentStyleId = "execution" | "analysis" | "companion" | "creative";

export interface ExpertAgentState {
  expertId: string;
  hired: boolean;
  packageVersion: string;
  summary: string;
  disclosure?: string;
  disclosureShown: boolean;
  lastConversationId?: string;
  events: Array<{ id: string; at: number; conversationId?: string }>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  avatar: AgentAvatarState;
  position: string;
  /** Present (even when empty) after the one-time legacy position split. */
  positionDescription?: string;
  styleId: AgentStyleId;
  /** User-authored identity; absent legacy values retain the selected style. */
  persona?: string;
  kind?: "custom" | "expert";
  expert?: ExpertAgentState;
  /** Other Agents explicitly opt into these capabilities; new capabilities stay off. */
  capabilityIds?: string[];
  /** Set when this identity is saved by the Agent editor. */
  identityEdited?: boolean;
  /** General assistant only: all capabilities are on unless explicitly disabled. */
  disabledCapabilityIds?: string[];
}

export interface AgentRegistry {
  schemaVersion: 1;
  /** Set only after the one-time, read-only legacy inspection. */
  legacyMigrationVersion: 0 | 1;
  legacyIdentitySyncVersion?: 1;
  agents: AgentDefinition[];
  moduleOwners: Record<AgentModuleId, string>;
}

/** Frozen identity/capabilities for historical attribution; never an authorization source. */
export interface AgentRunSnapshot {
  readonly agentId: string;
  readonly name: string;
  readonly position: string;
  readonly positionDescription?: string;
  readonly styleId: AgentStyleId;
  readonly persona?: string;
  readonly expertId?: string;
  readonly expertPackageVersion?: string;
  readonly capabilityIds?: readonly string[];
  readonly disabledCapabilityIds?: readonly string[];
}
