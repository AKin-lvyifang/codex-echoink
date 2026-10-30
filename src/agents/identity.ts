import type { AgentDefinition } from "./types";

/** The description's presence marks identities already split into three fields. */
export function normalizeAgentPosition(raw: Record<string, unknown>, expertSummary?: string): Pick<AgentDefinition, "position" | "positionDescription"> {
  const position = typeof raw.position === "string" ? raw.position.trim() : "";
  if (typeof raw.positionDescription === "string") return { position, positionDescription: raw.positionDescription.trim() };
  return expertSummary !== undefined
    ? { position, positionDescription: expertSummary.trim() }
    : { position: "", positionDescription: position };
}

export function agentDisplayTitle(agent: Pick<AgentDefinition, "name" | "position">, language = "zh-CN"): string {
  const position = agent.position.trim();
  return !position || position === agent.name.trim() ? agent.name : language === "en" ? `${agent.name} (${position})` : `${agent.name}（${position}）`;
}

export function agentPositionDescription(agent: Pick<AgentDefinition, "position" | "positionDescription" | "expert">): string {
  return agent.positionDescription ?? agent.expert?.summary ?? agent.position;
}
