import { AGENT_STYLES } from "./styles";
import { normalizeExpertDisclosure } from "../experts/disclosure";
import type { AgentDefinition, AgentStyleId, ExpertAgentState } from "./types";

export const AGENT_PERSONA_MAX_LENGTH = 4000;

/** Count Unicode code points, so one supplementary character uses one place. */
export function agentPersonaLength(value: string): number { return Array.from(value).length; }
export function normalizeAgentPersona(value: unknown): string {
  return typeof value === "string" ? Array.from(value).slice(0, AGENT_PERSONA_MAX_LENGTH).join("") : "";
}
export function assertAgentPersonaLength(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || agentPersonaLength(value) > AGENT_PERSONA_MAX_LENGTH)) throw new Error("agent_persona_invalid");
}

const TEMPLATE_IDENTITY: Record<AgentStyleId, [string, string]> = {
  execution: ["你的执行搭档。拿到事情就推进，不绕弯。", "Your execution partner. Move the work forward without unnecessary preamble."],
  analysis: ["帮你把事情想清楚的分析师。", "An analyst who helps you think things through."],
  companion: ["陪你聊今天、听你说心事的朋友。", "A thoughtful companion who listens and helps you reflect."],
  creative: ["陪你找点子的创意伙伴。", "A creative partner who explores ideas with you."]
};
const TEMPLATE_EN: Record<AgentStyleId, [string, string, string]> = {
  execution: ["Focus on the goal, constraints and acceptance criteria, then find the shortest action path. Move ahead when information is sufficient; use a small check when needed.", "Brief, confident and direct", "Conclusion → actions → risks"],
  analysis: ["Check assumptions, evidence and omissions; give the strongest case for each option before deciding.", "Measured, calm and evidence-led", "Judgment → evidence → uncertainty"],
  companion: ["Acknowledge feelings and circumstances, clarify the problem and constraints, then suggest one small practical step.", "Warm, thoughtful and considerate", "Response → clarity → one suggestion"],
  creative: ["Explore distinct directions, then narrow them to an option that fits the goal and constraints.", "Relaxed, lively and vivid", "Several directions → recommendation → next step"]
};

export function getAgentPersonaTemplate(styleId: AgentStyleId, language: "zh" | "en" = "zh"): string {
  const style = AGENT_STYLES.find(item => item.id === styleId) ?? AGENT_STYLES[0];
  if (language === "en") {
    const [thinking, tone, structure] = TEMPLATE_EN[style.id];
    return `## Who I am\n${TEMPLATE_IDENTITY[style.id][1]}\n\n## How I think\n${thinking}\n\n## How I speak\n${tone}. ${structure}.`;
  }
  return `## 我是谁\n${TEMPLATE_IDENTITY[style.id][0]}\n\n## 怎么想\n${style.thinking}\n\n## 怎么说\n${style.tone}。${style.responseStructure}。`;
}

/** Switching a built-in template is immediate; replacing authored prose needs confirmation. */
export function hasCustomAgentPersona(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !AGENT_STYLES.some(style => (["zh", "en"] as const).some(language => getAgentPersonaTemplate(style.id, language) === value));
}

export function isExpertAgent<T extends Pick<AgentDefinition, "kind" | "expert">>(agent: T | null | undefined): agent is T & { expert: ExpertAgentState } {
  return !!agent && (agent.kind === "expert" || agent.expert !== undefined);
}
export function isAgentHired(agent: Pick<AgentDefinition, "kind" | "expert"> | null | undefined): boolean {
  return !!agent && (!isExpertAgent(agent) || agent.expert?.hired === true);
}

export function normalizeExpertAgentState(value: unknown): ExpertAgentState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.expertId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/u.test(raw.expertId)) return undefined;
  const events: ExpertAgentState["events"] = [];
  for (const value of Array.isArray(raw.events) ? raw.events : []) {
    if (!value || typeof value !== "object") continue;
    const event = value as Record<string, unknown>;
    if (typeof event.id !== "string" || !event.id || typeof event.at !== "number" || !Number.isFinite(event.at)) continue;
    events.push({ id: event.id, at: event.at, ...(typeof event.conversationId === "string" && event.conversationId ? { conversationId: event.conversationId } : {}) });
  }
  const disclosure = normalizeExpertDisclosure(raw.disclosure);
  return { expertId: raw.expertId, hired: raw.hired === true, packageVersion: typeof raw.packageVersion === "string" ? raw.packageVersion : "",
    ...(disclosure ? { disclosure } : {}),
    summary: typeof raw.summary === "string" ? raw.summary : "", disclosureShown: raw.disclosureShown === true,
    ...(typeof raw.lastConversationId === "string" && raw.lastConversationId ? { lastConversationId: raw.lastConversationId } : {}), events };
}

const EXPERT_LOCK_FIELDS = ["id", "name", "avatar", "position", "positionDescription", "styleId", "persona", "kind", "expert", "capabilityIds", "disabledCapabilityIds", "identityEdited"] as const;
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}

/** Ordinary writes may change module ownership only. Hiring/state changes use a dedicated service path. */
export function assertExpertAgentLocks(previous: AgentDefinition | undefined, next: AgentDefinition | undefined): void {
  if (!previous || !isExpertAgent(previous)) {
    if (next && isExpertAgent(next)) throw new Error("expert_agent_requires_hiring_flow");
    return;
  }
  if (!next || EXPERT_LOCK_FIELDS.some(key => canonical(previous[key]) !== canonical(next[key]))) throw new Error("expert_agent_locked");
}

/** Merge stale editor drafts while retaining the latest locked expert identity/state. */
export function preserveExpertAgentLocks(previous: AgentDefinition, next: AgentDefinition): AgentDefinition {
  if (!isExpertAgent(previous)) return next;
  const preserved = { ...next };
  for (const key of EXPERT_LOCK_FIELDS) {
    if (previous[key] === undefined) delete preserved[key];
    else Object.assign(preserved, { [key]: structuredClone(previous[key]) });
  }
  return preserved;
}
