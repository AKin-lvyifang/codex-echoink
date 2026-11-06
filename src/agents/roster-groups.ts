import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "./types";

/** Group identity is fixed by the reserved main Agent ID, never by a name or capability. */
export function agentRoleGroups(agents: readonly AgentDefinition[], english = false) {
  return [
    { id: "main", label: english ? "Main Agent" : "主 Agent", agents: agents.filter(agent => agent.id === GENERAL_ASSISTANT_ID) },
    { id: "role", label: english ? "Role Agents" : "角色 Agent", agents: agents.filter(agent => agent.id !== GENERAL_ASSISTANT_ID) }
  ] as const;
}
