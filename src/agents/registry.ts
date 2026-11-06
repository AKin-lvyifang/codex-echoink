import { normalizeAgentAvatar, normalizeAgentDisplayName } from "../harness/memory/agent-identity-model";
import { normalizeAgentStyleId } from "./styles";
import { normalizeAgentPosition } from "./identity";
import { isAgentHired, isExpertAgent, normalizeAgentPersona, normalizeExpertAgentState } from "./persona";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, GENERALIST_AGENT_ID, isUndeletableAgent, usesDisabledCapabilityList, type AgentDefinition, type AgentModuleId, type AgentRegistry } from "./types";

export function defaultAgentRegistry(): AgentRegistry {
  return {
    schemaVersion: 1, legacyMigrationVersion: 0, moduleOwnerMigrationVersion: 1,
    agents: [{ id: GENERAL_ASSISTANT_ID, name: "总助", avatar: { kind: "preset", presetId: "sol" }, position: "", positionDescription: "听你说话、派活、收汇报", styleId: "execution", companyApprovalMode: "user", disabledCapabilityIds: [] }, defaultGeneralist()],
    moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => [id, ""])) as AgentRegistry["moduleOwners"]
  };
}

function defaultGeneralist(): AgentDefinition {
  return { id: GENERALIST_AGENT_ID, name: "通才", avatar: { kind: "preset", presetId: "bo" }, position: "", positionDescription: "没有专属模块的杂活都归我", styleId: "execution", disabledCapabilityIds: [] };
}

export function normalizeAgentRegistry(value: unknown, existingSettings = !!record(value)): AgentRegistry {
  const fallback = defaultAgentRegistry();
  const raw = record(value);
  if (!raw || raw.schemaVersion !== 1) {
    if (existingSettings) for (const id of AGENT_MODULE_IDS) fallback.moduleOwners[id] = GENERALIST_AGENT_ID;
    return fallback;
  }
  const seen = new Set<string>();
  const agents: AgentDefinition[] = [];
  for (const item of Array.isArray(raw.agents) ? raw.agents : []) {
    const agent = record(item);
    const id = normalizeAgentId(agent?.id);
    const name = typeof agent?.name === "string" ? normalizeAgentDisplayName(agent.name) : null;
    if (!agent || !id || !name || seen.has(id)) continue;
    seen.add(id);
    const expertKind = agent.kind === "expert" || agent.expert !== undefined;
    // Keep malformed expert markers locked and unavailable, rather than downgrading to editable Agents.
    const expert = normalizeExpertAgentState(agent.expert) ?? (expertKind ? { expertId: id.replace(/^expert-/u, ""), hired: false, packageVersion: "", summary: "", disclosureShown: false, events: [] } : undefined);
    if (expert && (id !== `expert-${expert.expertId}` || !expert.packageVersion.trim())) expert.hired = false;
    agents.push({ id, name, avatar: normalizeAgentAvatar(agent.avatar) ?? { kind: "default" }, ...normalizeAgentPosition(agent, expertKind ? expert?.summary ?? "" : undefined), ...(agent.identityEdited === true ? { identityEdited: true } : {}), ...(id === GENERAL_ASSISTANT_ID ? { companyApprovalMode: agent.companyApprovalMode === "assistant" ? "assistant" as const : "user" as const } : {}), styleId: normalizeAgentStyleId(agent.styleId),
      ...(expertKind ? { kind: "expert" as const, ...(expert ? { expert } : {}) } : { ...(agent.kind === "custom" ? { kind: "custom" as const } : {}), ...(typeof agent.persona === "string" ? { persona: normalizeAgentPersona(agent.persona) } : {}) }),
      ...(usesDisabledCapabilityList(id)
        ? { disabledCapabilityIds: normalizeCapabilityIds(agent.disabledCapabilityIds), ...(Array.isArray(agent.capabilityIds) ? { capabilityIds: normalizeCapabilityIds(agent.capabilityIds) } : {}) }
        : { capabilityIds: normalizeCapabilityIds(agent.capabilityIds), ...(Array.isArray(agent.disabledCapabilityIds) ? { disabledCapabilityIds: normalizeCapabilityIds(agent.disabledCapabilityIds) } : {}) }) });
  }
  if (!seen.has(GENERAL_ASSISTANT_ID)) agents.unshift(fallback.agents[0]);
  // Appended, so an existing roster keeps its order; the generalist only fills in.
  if (!seen.has(GENERALIST_AGENT_ID)) agents.push(defaultGeneralist());
  const owners = record(raw.moduleOwners);
  const migrated: AgentRegistry = {
    schemaVersion: 1, legacyMigrationVersion: raw.legacyMigrationVersion === 1 ? 1 : 0, ...(raw.legacyIdentitySyncVersion === 1 ? { legacyIdentitySyncVersion: 1 as const } : {}), agents,
    moduleOwnerMigrationVersion: 1,
    moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => {
      const owner = raw.moduleOwnerMigrationVersion !== 1 && owners?.[id] === GENERAL_ASSISTANT_ID ? GENERALIST_AGENT_ID : owners?.[id];
      return [id, typeof owner === "string" && owner !== GENERAL_ASSISTANT_ID && agents.some(agent => agent.id === owner && isAgentHired(agent)) ? owner : ""];
    })) as AgentRegistry["moduleOwners"]
  };
  for (const id of AGENT_MODULE_IDS) {
    const owner = getModuleOwner(migrated, id);
    if (owner) grantModuleCapabilities(owner, id);
  }
  return migrated;
}

export function setModuleOwner(registry: AgentRegistry, moduleId: AgentModuleId, agentId: string): AgentRegistry {
  if (!AGENT_MODULE_IDS.includes(moduleId) || agentId === GENERAL_ASSISTANT_ID || agentId && !registry.agents.some(agent => agent.id === agentId && isAgentHired(agent))) throw new Error("agent_module_owner_invalid");
  return { ...registry, agents: registry.agents.map(agent => {
    if (agent.id !== agentId) return agent;
    const next = structuredClone(agent); grantModuleCapabilities(next, moduleId); return next;
  }), moduleOwners: { ...registry.moduleOwners, [moduleId]: agentId } };
}

export function getModuleOwner(registry: AgentRegistry, moduleId: AgentModuleId): AgentDefinition | null {
  const id = registry.moduleOwners[moduleId];
  return id && id !== GENERAL_ASSISTANT_ID ? registry.agents.find(agent => agent.id === id && isAgentHired(agent)) ?? null : null;
}

export const moduleCapability = (moduleId: AgentModuleId): string => moduleId === "knowledge-base" ? "knowledge" : moduleId;
export function grantModuleCapabilities(agent: AgentDefinition, moduleId: AgentModuleId): void {
  if (isExpertAgent(agent)) return;
  const capability = moduleCapability(moduleId);
  if (usesDisabledCapabilityList(agent.id)) agent.disabledCapabilityIds = (agent.disabledCapabilityIds ?? []).filter(id => id !== capability);
  else agent.capabilityIds = [...new Set([...(agent.capabilityIds ?? []), capability])];
}

export class ModuleOwnerRequired extends Error {
  readonly code = "module_owner_required";
  constructor(readonly moduleId: AgentModuleId) { super(`${moduleId} has no module owner`); }
}
export function requireModuleOwner(registry: AgentRegistry, moduleId: AgentModuleId): AgentDefinition {
  const owner = getModuleOwner(registry, moduleId);
  if (!owner) throw new ModuleOwnerRequired(moduleId);
  return owner;
}

/** Pure data handoff only. The caller must stop and settle active runs first. */
export function removeAgentDefinition(registry: AgentRegistry, agentId: string): AgentRegistry {
  if (isUndeletableAgent(agentId)) throw new Error("general_assistant_cannot_be_deleted");
  if (registry.agents.some(agent => agent.id === agentId && isExpertAgent(agent))) throw new Error("expert_agent_requires_dismissal_flow");
  return { ...registry, agents: registry.agents.filter(agent => agent.id !== agentId), moduleOwners: Object.fromEntries(AGENT_MODULE_IDS.map(id => [id, registry.moduleOwners[id] === agentId ? "" : registry.moduleOwners[id]])) as AgentRegistry["moduleOwners"] };
}

export function normalizeAgentId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function normalizeCapabilityIds(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((id): id is string => typeof id === "string" && !!id.trim()).map(id => id.trim()))];
}
