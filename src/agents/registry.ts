import { normalizeAgentAvatar, normalizeAgentDisplayName } from "../harness/memory/agent-identity-model";
import { normalizeAgentStyleId } from "./styles";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId, type AgentRegistry } from "./types";

export function defaultAgentRegistry(): AgentRegistry {
  return {
    schemaVersion: 1, legacyMigrationVersion: 0,
    agents: [{ id: GENERAL_ASSISTANT_ID, name: "总助", avatar: { kind: "preset", presetId: "sol" }, position: "什么都能接，专门的活转给同事", styleId: "execution", disabledCapabilityIds: [] }],
    moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => [id, GENERAL_ASSISTANT_ID])) as AgentRegistry["moduleOwners"]
  };
}

export function normalizeAgentRegistry(value: unknown): AgentRegistry {
  const fallback = defaultAgentRegistry();
  const raw = record(value);
  if (!raw || raw.schemaVersion !== 1) return fallback;
  const seen = new Set<string>();
  const agents: AgentDefinition[] = [];
  for (const item of Array.isArray(raw.agents) ? raw.agents : []) {
    const agent = record(item);
    const id = normalizeAgentId(agent?.id);
    const name = typeof agent?.name === "string" ? normalizeAgentDisplayName(agent.name) : null;
    if (!agent || !id || !name || seen.has(id)) continue;
    seen.add(id);
    agents.push({ id, name, avatar: normalizeAgentAvatar(agent.avatar) ?? { kind: "default" }, position: text(agent.position), styleId: normalizeAgentStyleId(agent.styleId),
      ...(id === GENERAL_ASSISTANT_ID
        ? { disabledCapabilityIds: normalizeCapabilityIds(agent.disabledCapabilityIds) }
        : { capabilityIds: normalizeCapabilityIds(agent.capabilityIds) }) });
  }
  if (!seen.has(GENERAL_ASSISTANT_ID)) agents.unshift(fallback.agents[0]);
  const owners = record(raw.moduleOwners);
  return {
    schemaVersion: 1, legacyMigrationVersion: raw.legacyMigrationVersion === 1 ? 1 : 0, agents,
    moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => [id, agents.some(agent => agent.id === owners?.[id]) ? owners![id] : GENERAL_ASSISTANT_ID])) as AgentRegistry["moduleOwners"]
  };
}

export function setModuleOwner(registry: AgentRegistry, moduleId: AgentModuleId, agentId: string): AgentRegistry {
  if (!AGENT_MODULE_IDS.includes(moduleId) || !registry.agents.some(agent => agent.id === agentId)) throw new Error("agent_module_owner_invalid");
  return { ...registry, moduleOwners: { ...registry.moduleOwners, [moduleId]: agentId } };
}

/** Pure data handoff only. The caller must stop and settle active runs first. */
export function removeAgentDefinition(registry: AgentRegistry, agentId: string): AgentRegistry {
  if (agentId === GENERAL_ASSISTANT_ID) throw new Error("general_assistant_cannot_be_deleted");
  return { ...registry, agents: registry.agents.filter(agent => agent.id !== agentId), moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => [id, registry.moduleOwners[id] === agentId ? GENERAL_ASSISTANT_ID : registry.moduleOwners[id]])) as AgentRegistry["moduleOwners"] };
}

export function normalizeAgentId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function normalizeCapabilityIds(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((id): id is string => typeof id === "string" && !!id.trim()).map(id => id.trim()))];
}
