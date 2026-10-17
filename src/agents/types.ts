import type { AgentAvatarState } from "../harness/memory/agent-identity-model";

export const GENERAL_ASSISTANT_ID = "sol";
export const AGENT_MODULE_IDS = [
  "journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"
] as const;
export type AgentModuleId = typeof AGENT_MODULE_IDS[number];
export type AgentStyleId = "execution" | "analysis" | "companion" | "creative";

export interface AgentDefinition {
  id: string;
  name: string;
  avatar: AgentAvatarState;
  position: string;
  styleId: AgentStyleId;
  /** Other Agents explicitly opt into these capabilities; new capabilities stay off. */
  capabilityIds?: string[];
  /** General assistant only: all capabilities are on unless explicitly disabled. */
  disabledCapabilityIds?: string[];
}

export interface AgentRegistry {
  schemaVersion: 1;
  /** Set only after the one-time, read-only legacy inspection. */
  legacyMigrationVersion: 0 | 1;
  agents: AgentDefinition[];
  moduleOwners: Record<AgentModuleId, string>;
}

/** Frozen identity/capabilities for historical attribution; never an authorization source. */
export interface AgentRunSnapshot {
  readonly agentId: string;
  readonly name: string;
  readonly position: string;
  readonly styleId: AgentStyleId;
  readonly capabilityIds?: readonly string[];
  readonly disabledCapabilityIds?: readonly string[];
}
