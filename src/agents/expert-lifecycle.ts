import type { AgentDefinition, AgentRegistry } from "./types";
import { GENERAL_ASSISTANT_ID, AGENT_MODULE_IDS } from "./types";
import { isExpertAgent } from "./persona";
import { normalizeExpertDisclosure } from "../experts/disclosure";
import type { ResolvedExpertPackage } from "../experts/service";

/** No package body or credential belongs in the Agent registry. */
export function hireExpert(registry: AgentRegistry, pack: ResolvedExpertPackage, at = Date.now()): AgentDefinition {
  const id = `expert-${pack.id}`;
  if (id.length > 128) throw new Error("专家身份过长。");
  const previous = registry.agents.find(agent => agent.id === id);
  if (previous && (!isExpertAgent(previous) || previous.expert.expertId !== pack.id)) throw new Error("专家身份已被其他 Agent 使用。");
  const rehired = !!previous && !previous.expert?.hired;
  const expert = previous?.expert;
  const disclosure = normalizeExpertDisclosure(pack.disclosure);
  const next: AgentDefinition = {
    id, kind: "expert", name: pack.name, position: pack.meta.scene, positionDescription: pack.summary, avatar: pack.avatar,
    styleId: "execution", identityEdited: true,
    expert: { expertId: pack.id, hired: true, packageVersion: pack.version, summary: pack.summary,
      ...(disclosure ? { disclosure } : {}),
      disclosureShown: expert?.disclosureShown ?? false,
      ...(expert?.lastConversationId ? { lastConversationId: expert.lastConversationId } : {}),
      events: [...(expert?.events ?? []), ...(rehired ? [{ id: crypto.randomUUID(), at }] : [])] }
  };
  if (previous) registry.agents[registry.agents.indexOf(previous)] = next;
  else registry.agents.push(next);
  return next;
}

export function dismissExpert(registry: AgentRegistry, agentId: string): void {
  const agent = registry.agents.find(item => item.id === agentId);
  if (!isExpertAgent(agent)) throw new Error("专家不存在。");
  agent.expert.hired = false;
  for (const moduleId of AGENT_MODULE_IDS) if (registry.moduleOwners[moduleId] === agentId) registry.moduleOwners[moduleId] = GENERAL_ASSISTANT_ID;
}

export function rememberExpertConversation(registry: AgentRegistry, agentId: string, conversationId: string, at = Date.now()): void {
  const agent = registry.agents.find(item => item.id === agentId);
  if (!isExpertAgent(agent) || !agent.expert.hired) throw new Error("专家已解聘。");
  agent.expert.lastConversationId = conversationId;
  for (const event of agent.expert.events) if (!event.conversationId) event.conversationId = conversationId;
  if (!agent.expert.disclosureShown) {
    agent.expert.events.push({ id: "disclosure", at, conversationId });
    agent.expert.disclosureShown = true;
  }
}
