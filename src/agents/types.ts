import type { AgentAvatarState } from "../harness/memory/agent-identity-model";
import { isCommunityExpert, type ExpertSource } from "../experts/source";
import type { ReasoningEffort } from "../types/app-server";

export const GENERAL_ASSISTANT_ID = "sol";
/** Default worker: inherits everything the general assistant could do before it became a router. */
export const GENERALIST_AGENT_ID = "generalist";
/** Preserve the two original Agents' defaults for non-basic capabilities. */
export const usesDisabledCapabilityList = (agentId: string): boolean => agentId === GENERAL_ASSISTANT_ID || agentId === GENERALIST_AGENT_ID;
export const isUndeletableAgent = usesDisabledCapabilityList;
const BASIC_AGENT_CAPABILITIES = new Set(["conversation", "memory", "vault-notes", "web-search"]);
export const isBasicAgentCapability = (id: string): boolean => BASIC_AGENT_CAPABILITIES.has(id);
/** Built-in work every hired, non-expert Agent may do; module switches, PRO and access modes still apply per action. */
const BUILTIN_AGENT_CAPABILITIES = new Set([...BASIC_AGENT_CAPABILITIES, "journal", "todos", "finance", "knowledge", "english-diary", "pdf-reading", "review", "obsidian-plugins"]);
export const isBuiltinAgentCapability = (id: string): boolean => BUILTIN_AGENT_CAPABILITIES.has(id);
export function isCommunityExpertAgent(agent?: Pick<AgentDefinition, "expert">): boolean {
  return !!agent?.expert && isCommunityExpert(agent.expert.expertId, agent.expert.source);
}
export function hasAgentCapabilityGrant(agent: Pick<AgentDefinition, "id" | "capabilityIds" | "disabledCapabilityIds" | "expert"> & { kind?: AgentDefinition["kind"] }, id: string): boolean {
  // Legacy per-Agent opt-outs of built-in work have no editor anymore, so they are not honored.
  if (agent.kind !== "expert" && !agent.expert && isBuiltinAgentCapability(id)) return true;
  const basic = isBasicAgentCapability(id) && !(id === "web-search" && isCommunityExpertAgent(agent));
  return !agent.disabledCapabilityIds?.includes(id)
    && (basic || usesDisabledCapabilityList(agent.id) || agent.capabilityIds?.includes(id) === true);
}
export function setAgentCapabilityGrant(agent: AgentDefinition, id: string, enabled: boolean): void {
  const basic = isBasicAgentCapability(id) && !(id === "web-search" && isCommunityExpertAgent(agent));
  const key = basic || usesDisabledCapabilityList(agent.id) ? "disabledCapabilityIds" : "capabilityIds";
  const ids = new Set(agent[key]);
  if (key === "disabledCapabilityIds" ? !enabled : enabled) ids.add(id);
  else ids.delete(id);
  agent[key] = [...ids];
  if (key === "capabilityIds" && agent.disabledCapabilityIds?.includes(id)) {
    agent.disabledCapabilityIds = agent.disabledCapabilityIds.filter(value => value !== id);
  }
}
export const AGENT_MODULE_IDS = [
  "journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "review"
] as const;
export type AgentModuleId = typeof AGENT_MODULE_IDS[number];
export const AGENT_MODULE_NAMES: Record<AgentModuleId, [string, string]> = {
  journal: ["日记", "Journal"], todos: ["待办", "To-dos"], finance: ["财务", "Finance"],
  "knowledge-base": ["知识库", "Knowledge"], "english-diary": ["英文日记", "English diary"],
  "pdf-reading": ["PDF 精读", "PDF reading"], review: ["复盘", "Review"]
};
export type AgentStyleId = "execution" | "analysis" | "companion" | "creative";

export interface ExpertAgentState {
  expertId: string;
  source?: ExpertSource;
  hired: boolean;
  packageVersion: string;
  summary: string;
  displayNameOverride?: string;
  avatarOverride?: AgentAvatarState;
  disclosure?: string;
  disclosureShown: boolean;
  lastConversationId?: string;
  events: Array<{ id: string; at: number; conversationId?: string }>;
}

export type CompanyApprovalMode = "user" | "assistant";

/** The Agent's own model; a manual switch inside one conversation never writes back here. */
export interface AgentModelPreference {
  providerSettingsId: string;
  modelId: string;
  /** Absent means the model's own default effort. "none" turns reasoning off. */
  reasoning?: ReasoningEffort;
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
  /** Only the main Agent owns the company approval preference. */
  companyApprovalMode?: CompanyApprovalMode;
  /** Absent means the Agent follows the model chosen in the current conversation. */
  model?: AgentModelPreference;
  kind?: "custom" | "expert";
  expert?: ExpertAgentState;
  /** Opt-in grants for specialized capabilities. Legacy basic grants are ignored by tools. */
  capabilityIds?: string[];
  /** Set when this identity is saved by the Agent editor. */
  identityEdited?: boolean;
  /** Explicit basic capability opt-outs and existing per-Agent resource exclusions. */
  disabledCapabilityIds?: string[];
}

export interface AgentRegistry {
  schemaVersion: 1;
  /** Set only after the one-time, read-only legacy inspection. */
  legacyMigrationVersion: 0 | 1;
  legacyIdentitySyncVersion?: 1;
  /** Empty module assignments must never be repaired by a later load. */
  moduleOwnerMigrationVersion?: 1;
  capabilityMigrationVersion?: 1;
  agents: AgentDefinition[];
  /** Empty string means explicitly unassigned. */
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
